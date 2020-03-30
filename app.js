const debug = require('debug')('matrix-puppet:slack:app');
const { MatrixPuppetBridgeBase } = require("matrix-puppet-bridge");
const config = require('./config.json');
const SlackClient = require('./client');
const slackdown = require('./slackdown');
const mxtoslack = require('./mxtoslack');
const showdown  = require('showdown');
const emojione = require('emojione')
const { sleep } = require('./utils');
const converter = new showdown.Converter({
  literalMidWordUnderscores : true,
  simpleLineBreaks: true
});

class App extends MatrixPuppetBridgeBase {
  setSlackTeam(teamName, userAccessToken, notify) {
    this.teamName = teamName;
    this.userAccessToken = userAccessToken;
    this.slackPrefix = config.prefix;
    this.servicePrefix = `${this.slackPrefix}_${this.teamName}`;
    this.notifyToSlack = notify;
    this.matrixRoomStatus = {};
  }
  getServiceName() {
    return "Slack";
  }
  getServicePrefix() {
    return this.servicePrefix;
  }
  async sendStatus(_msg) {
    const msg = `${this.teamName}: ${_msg}`
    try {
      await this.sendStatusMsg({
        fixedWidthOutput: false,
        roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
      }, msg);
    } catch (err) {
      debug('could not send status message', err.message);
    }
  }
  async initThirdPartyClient() {
    this.client = new SlackClient(this.userAccessToken);
    this.client.on('unable-to-start', (err)=>{
      this.sendStatus(`unable to start: ${err.message}`);
    });
    this.client.on('disconnected', async()=>{
      await this.sendStatus('disconnected. will try to reconnect in a minute...');
      await sleep(60 * 1000);
      try {
        await this.initThirdPartyClient();
      } catch (err) {
        debug('reconnect failed with error', err.message);
        await this.sendStatus('reconnnect failed with error', err.message);
      }
    });
    this.client.on('connected', ()=>{
      this.sendStatus(`connected`);
    });
    await this.client.connect();
    // XXX: need to wait?
    debug('waiting a little bit for initial self-messages to fire before listening for messages');
    await sleep(5000);
    await this.registerMessageListener();
  }
  registerMessageListener() {
    this.client.on('message', async(data)=>{
      // console.log(data);
      // edit message
      if (data.subtype === "message_changed") {
        if (data.message.text === data.previous_message.text) {
          // do nothing
          debug('ignoring duplicate edit', data);
          return;
        }
        await this.createAndSendPayload({
          channel: data.channel,
          text: `Edit: ${data.message.text}`,
          user: data.message.user
        });
        return;
      }
      // with files
      if (data.files) {
        let promises = [];
        if (data.text) {
          promises.push(this.createAndSendPayload({
            channel: data.channel,
            text: data.text,
            attachments: data.attachments,
            bot_id: data.bot_id,
            user: data.user,
            user_profile: data.user_profile,
          }));
        }
        const attachs = data.files.map(async(file) => {
          const d = {
            channel: data.channel,
            text: data.text,
            attachments: data.attachments,
            bot_id: data.bot_id,
            user: data.user,
            user_profile: data.user_profile,
            file: file,
          };
          await this.sendFile(d);
          if (!d.file.initial_comment) {
            return;
          }
          return await this.createAndSendPayload({
            channel: d.channel,
            text: d.file.initial_comment.comment,
            attachments: d.attachments,
            bot_id: d.bot_id,
            user: d.user,
            user_profile: d.user_profile,
          });
        });
        promises = promises.concat(attachs);
        try {
          await Promise.all(promises);
        } catch (err) {
          try {
            await this.sendStatusMsg({
              fixedWidthOutput: true,
              roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
            }, err.stack);
          } catch (err) {
            debug('could not send status message with error', err.message);
          }
        }
        return;
      }
      // normal message
      await this.createAndSendPayload({
        channel: data.channel,
        text: data.text,
        attachments: data.attachments,
        bot_id: data.bot_id,
        user: data.user,
        user_profile: data.user_profile,
      });
    });

    this.client.on('typing', async(data)=>{
      // console.log(data);
      await this.createAndSendTypingEvent({
        channel: data.channel,
        user: data.user,
      });
    });
    this.client.on('rename', async(data)=>{
      // console.log(data);
      // rename channel
      await this.renameChannelEvent({
        channel: data.channel,
      });
    });
    debug('registered message listener');
  }
  async getPayload(data) {
    const {
      channel,
      bot_id,
      user,
    } = data;

    let payload = { roomId: channel };

    if (user) {
      if ( user === "USLACKBOT" ) {
        const u = await this.client.getUserById(user);
        payload.senderName = u.name;
        payload.senderId = user;
        payload.avatarUrl = u.profile.image_72;
      } else {
        const isMe = user === this.client.getSelfUserId();
        let uu = await this.client.getUserById(user);
        payload.senderId = isMe ? undefined : user;
        if (uu) {
          payload.senderName = uu.name;
          payload.avatarUrl = uu.profile.image_512;
        } else {
          payload.senderName = "unknown";
        }
      }
    } else if (bot_id) {
      const bot = await this.client.getBotById(bot_id);
      payload.senderName = bot.name;
      payload.senderId = bot_id;
      payload.avatarUrl = bot.icons.image_72
    }
    return payload;
  }
  async sendFile(data) {
    let payload = await this.getPayload(data);
    payload.text = data.file.name;
    payload.url = ''; // to prevent errors
    payload.path = ''; // to prevent errors
    try {
      const { buffer, type } = await this.client.downloadImage(data.file.url_private);
      payload.buffer = buffer;
      payload.mimetype = type;
      return await this.handleThirdPartyRoomMessageWithAttachment(payload);
    } catch (err) {
      debug('could not send the file data', err.message);
      payload.text = '[Image] ('+data.name+') '+data.url;
      return await this.handleThirdPartyRoomMessage(payload);
    }
  }
  async createAndSendPayload(data) {
    const {
      text,
      attachments,
    } = data;

    // any direct text
    let messages = [text];
    // any attachments, stuff it into the text as new lines
    if (attachments) {
      /* FIXME: Right now, doing this properly would cause too much churn.
       * The attachments are also in Slack's markdown-like
       * formatting, not real markdown, but they require features
       * (e.g. links with custom text) that Slack formatting doesn't support.
       * Because we need to process the "slackdown", but also implement those
       * features, we mix in some real markdown that makes it past our
       * slackdown-to-markdown converter. We also need <font> tags for our
       * colorization, but the converter can't handle the raw HTML (which
       * slackdown doesn't allow), and we don't want to turn HTML in Slack
       * messages into real HTML (it should show as plaintext just like it
       * does in Slack, lest we try to turn "</sarcasm>" into real end tags),
       * so we hack around it by implementing our own silly font color hack.
       * A good fix would be to parse individual messages' slackdown
       * to markdown, and add the additional markdown
       * (including raw HTML tags) afterward, instead of forming a big array
       * of slackdown messages, then converting them all into markdown at once.
       */
      attachments.forEach(att=> {
        let attMessages = [];
        if (att.pretext) {
          messages.push(att.pretext);
        }
        if (att.author_name) {
          if (att.author_link) {
            attMessages.push(`[${att.author_name}](${att.author_link})`);
          } else {
            attMessages.push(`${att.author_name}`);
          }
        }
        if (att.title) {
          if (att.title_link) {
            attMessages.push(`*[${att.title}](${att.title_link})*`);
          } else {
            attMessages.push(`*${att.title}*`);
          }
        }
        if (att.text) {
          attMessages.push(`${att.text}`);
        }
        if (att.fields) {
          att.fields.forEach(field => {
            if (field.title) {
              attMessages.push(`*${field.title}*`);
            }
            if (field.value) {
              attMessages.push(`${field.value}`);
            }
          })
        }
        if ((att.actions instanceof Array) && att.actions.length > 0) {
          attMessages.push(`Actions (Unsupported): ${att.actions.map(o => `[${o.text}]`).join(" ")}`);
        }
        if (att.footer) {
          attMessages.push(`_${att.footer}_`);
        }
        let attachmentBullet = att.color ? `;BEGIN_FONT_COLOR_HACK_${att.color};●;END_FONT_COLOR_HACK;` : "●";
        attMessages.forEach(attMessage => {
          messages.push(`${attachmentBullet} ${attMessage}`);
        });
      });
    }

    let rawMessage =
      messages
        .filter(m => m && (typeof m === "string"))
        .map(m => m.trim())
        .join('\n')
        .trim();
    let payload = await this.getPayload(data);

    try {
      const replacements = [
        [':+1:', ':thumbsup:'],
        [':-1:', ':thumbsdown:'],
        [':facepunch:', ':punch:'],
        [':hankey:', ':poop:'],
        [':slightly_smiling_face:', ':slight_smile:'],
        [':upside_down_face:', ':upside_down:'],
        [':skin-tone-2:', '🏻'],
        [':skin-tone-3:', '🏼'],
        [':skin-tone-4:', '🏽'],
        [':skin-tone-5:', '🏾'],
        [':skin-tone-6:', '🏿'],
        ['<!channel>', '@room'],
        ['<!here>', '@room'],
          // NOTE: <!channel> and `<!here> converted to @room here,
          // and not in slacktomd, because we're translating Slack parlance
          // to Matrix parlance, not parsing "Slackdown" to turn into Markdown.
      ];
      for (let i = 0; i < replacements.length; i++) {
        rawMessage = rawMessage.replace(replacements[i][0], replacements[i][1]);
      }
      rawMessage = emojione.shortnameToUnicode(rawMessage);
      debug('rawMessage', rawMessage);
      payload.text = await slackdown(this, rawMessage);
      let markdown = payload.text;
      markdown = markdown.replace(/;BEGIN_FONT_COLOR_HACK_(.*?);/g, '<font color="$1">');
      markdown = markdown.replace(/;END_FONT_COLOR_HACK;/g, '</font>');
      payload.text = payload.text.replace(/;BEGIN_FONT_COLOR_HACK_(.*?);/g, '');
      payload.text = payload.text.replace(/;END_FONT_COLOR_HACK;/g, '');

      // Replace a slack user mention.
      // In the body it should be replaced with the nick and in the html a href.

      let result = [];
      while ((result = /USER_MENTION_HACK(.*?)END_USER_MENTION_HACK/g.exec(payload.text)) !== null) {
        // console.log(result);
        const u = result[1];
        const isme = u === this.client.getSelfUserId();
        const user = await this.client.getUserById(u);
        if (user) {
            const id = isme ? config.puppet.id : this.getGhostUserFromThirdPartySenderId(u);
            // todo: update user profile
            const name = isme ? config.puppet.localpart : user.name;
            const mentionmd = `[${name}](https://matrix.to/#/${id})`;
            payload.text = payload.text.replace(result[0], name);
            markdown = markdown.replace(result[0], mentionmd);
        } else {
            payload.text = payload.text.replace(result[0], u);
            markdown = markdown.replace(result[0], u);

        }
      }
      debug('payload.text', payload.text);
      payload.html = converter.makeHtml(markdown);
      debug('payload.html', payload.html);
    } catch (e) {
      debug("could not normalize message", e.message);
      payload.text = rawMessage;
    }

    try {
      await this.handleThirdPartyRoomMessage(payload);
    } catch (err) {
      debug('could not send the message', err.message);
      try {
        await this.sendStatusMsg({
          fixedWidthOutput: true,
          roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
        }, err.stack);
      } catch (err) {
        debug('could not send status message', err.message);
      }
    }
  }

  async createAndSendTypingEvent(data) {
    const payload = await this.getPayload(data);
    try {
      const ghostIntent = await this.getIntentFromThirdPartySenderId(payload.senderId);
      const matrixRoomId = await this.getOrCreateMatrixRoomFromThirdPartyRoomId(payload.roomId);
      // HACK: copy from matrix-appservice-bridge/lib/components/indent.js
      // client can get timeout value, but intent does not support this yet.
      //return ghostIntent.sendTyping(matrixRoomId, true);
      await ghostIntent._ensureJoined(matrixRoomId);
      await ghostIntent._ensureHasPowerLevelFor(matrixRoomId, "m.typing");
      return ghostIntent.client.sendTyping(matrixRoomId, true, 3000);
    } catch (err) {
      debug('could not send typing event', err.message);
      try {
        await this.sendStatusMsg({
          fixedWidthOutput: true,
          roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
        }, err.stack);
      } catch (err) {
        debug('could not send status message', err.message);
      }
    }
  }

  async _renameChannelEvent(matrixRoomId, name) {
    const botIntent = this.getIntentFromApplicationServerBot();
    const ret = await botIntent.setRoomName(matrixRoomId, name);
    this.updateRoomStatesCache(matrixRoomId, 'name', name);
    return ret;
  }

  async renameChannelEvent(data) {
    const payload = await this.getPayload(data);
    const roomAlias = this.getRoomAliasFromThirdPartyRoomId(payload.roomId);
    try {
      const room = await this.puppet.getClient().getRoomIdForAlias(roomAlias);
      return await this._renameChannelEvent(room.room_id, data.name);
    } catch (err) {
      debug('could not send rename event', err.message);
      try {
        await this.sendStatusMsg({
          fixedWidthOutput: true,
          roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
        }, err.stack);
      } catch (err) {
        debug('could not send status message', err.message);
      }
    }
  }

  async getThirdPartyRoomDataById(id) {
    const directName = async(user) => (await this.client.getUserById(user)).name;
    const directTopic = () => `Slack Direct Message (Team: ${this.teamName})`
    const room = await this.client.getRoomById(id);
    let purpose = "";
    if ((room.purpose) && room.purpose.value) {
      purpose = room.purpose.value;
    }
    return {
      name: room.isDirect ? (await directName(room.user)) : room.name,
      topic: room.isDirect ? directTopic() : purpose
    }
  }

  async sendReadReceiptAsPuppetToThirdPartyRoomWithId() {
    // not available for now
  }

  async sendMessageAsPuppetToThirdPartyRoomWithId(id, text, data) {
    debug('sending message as puppet to third party room with id', id);
    // text lost html informations, just use raw message instead that.
    let message;
    if (data.content.format === 'org.matrix.custom.html') {
      const rawMessage = data.content.formatted_body;

      //console.log("rawMessage");
      //console.log(rawMessage);

      message = await mxtoslack(this, rawMessage);
    } else {
      message = data.content.body;
    }

    const replacements = [
      ['@room', this.notifyToSlack !== 'only_active' ? '<!channel>' : '<!here>'],
    ]
    for (let i = 0; i < replacements.length; i++) {
      message = message.replace(replacements[i][0], replacements[i][1]);
    }
    // deduplicate
    message = this.tagMatrixMessage(message);
    return this.client.sendMessage(message, id);
  }

  async sendImageMessageAsPuppetToThirdPartyRoomWithId(id, data, raw) {
    return this.client.sendImageMessage(data.url, data.text, id);
  }

  async sendFileMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    // deduplicate
    const filename = this.tagMatrixMessage(data.filename);
    return this.client.sendFileMessage(data.url, data.text, filename, id);
  }

  async getRoomState(matrixRoomId, type) {
    // prevent refetch from matrix server after first fetching
    const cache = this.matrixRoomStatus[matrixRoomId] || {};
    if (cache[type]) {
      return cache[type];
    }
    const puppetClient = this.puppet.getClient();
    switch(type) {
      case 'name':
        try {
          const roomName = await puppetClient.getStateEvent(matrixRoomId, 'm.room.name');
          if (roomName && roomName.name) {
            this.updateRoomStatesCache(matrixRoomId, 'name', roomName.name);
          }
          return roomName.name;
        } catch (e) {
          if (e.errcode === 'M_NOT_FOUND') {
            return;
          }
          throw e;
        }
      // TODO
    }
  }

  updateRoomStatesCache(matrixRoomId, type, data) {
    const roomStatus = this.matrixRoomStatus[matrixRoomId] = this.matrixRoomStatus[matrixRoomId] || {};
    roomStatus[type] = data;
  }

  // HACK: recheck the old name when after getOrCreateMatrixRoomFromThirdPartyRoomId
  // if room has old name, forcefully update new name after bind
  async getOrCreateMatrixRoomFromThirdPartyRoomId(thirdPartyRoomId) {
    const matrixRoomId = await super.getOrCreateMatrixRoomFromThirdPartyRoomId(thirdPartyRoomId);
    const name = await this.getRoomState(matrixRoomId, 'name');
    const data = await this.getThirdPartyRoomDataById(thirdPartyRoomId);
    if (!data.name) {
      return matrixRoomId;
    }
    if (name !== data.name) {
      await this._renameChannelEvent(matrixRoomId, data.name);
    }
    return matrixRoomId;
  }
}

module.exports = App;
