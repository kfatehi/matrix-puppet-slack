import {
  ThirdPartyAdapter,
  
  download, entities,
  
  ThirdPartyPayload, ThirdPartyMessagePayload, ThirdPartyImageMessagePayload,
  UserData, RoomData
} from 'matrix-puppet-bridge';

import * as path from 'path';
import * as emojione from 'emojione';

const debug = require('debug')('matrix-puppet:slack');
import { slackdown } from './slackdown';
import * as showdown from 'showdown';
const converter = new showdown.Converter({
  literalMidWordUnderscores : true,
  simpleLineBreaks: true
});
import { SlackClient } from './client'

export class Adapter extends ThirdPartyAdapter {
  public serviceName = 'Slack';
  private client: SlackClient;
  private teamName: string;
  startClient(): Promise<void> {
    this.teamName = this.config.team_name;
    this.client = new SlackClient(this.config.user_access_token);
    this.client.on('unable-to-start', (err)=>{
      this.puppetBridge.sendStatusMsg({},`unable to start: ${err.message}`);
    });
    this.client.on('disconnected', ()=>{
      this.puppetBridge.sendStatusMsg({},'disconnected. will try to reconnect in a minute...');
      setTimeout(()=> {
        this.startClient().catch((err)=>{
          debug('reconnect failed with error', err.message);
          this.puppetBridge.sendStatusMsg({},'reconnnect failed with error', err.message);
        })
      }, 60 * 1000);
    });
    this.client.on('connected', (err)=>{
      this.puppetBridge.sendStatusMsg({},`connected`);
    });
    return this.client.connect().then(()=>{
      debug('waiting a little bit for initial self-messages to fire before listening for messages');
      setTimeout(()=>this.registerMessageListener(), 5000);
    });
  }
  registerMessageListener() {
    this.client.on('message', (data)=>{
      console.log(data);
      if (data.subtype === "message_changed") {
        this.createAndSendPayload({
          channel: data.channel,
          text: `Edit: ${data.message.text}`,
          user: data.message.user
        });
      } else {
        if (data.file) {
          this.sendFile(data).then(() => {
            if (data.file.initial_comment) {
              this.createAndSendPayload({
                channel: data.channel,
                text: data.file.initial_comment.comment,
                attachments: data.attachments,
                bot_id: data.bot_id,
                user: data.user,
                user_profile: data.user_profile,
              });
            }
          });
        } else {
          this.createAndSendPayload({
            channel: data.channel,
            text: data.text,
            attachments: data.attachments,
            bot_id: data.bot_id,
            user: data.user,
            user_profile: data.user_profile,
          });
        }
      }
    });
    debug('registered message listener');
  }
  getPayload(data): ThirdPartyPayload {
    let payload = <ThirdPartyPayload>{
      roomId: data.channel,
      senderId: undefined,
    };
    if (data.user) {
      if (data.user === 'USLACKBOT') {
        payload.senderName = data.user_profile ? data.user_profile.name : 'unknown';
        payload.senderId = data.user;
        payload.avatarUrl = data.user_profile ? data.user_profile.image_72 : undefined;
      } else {
        const isMe = data.user === this.client.getSelfUserId();
        let uu = this.client.getUserById(data.user);
        payload.senderId = isMe ? undefined : data.user;
        if (uu) {
          payload.senderName = uu.name;
          payload.avatarUrl = uu.profile.image_512;
        } else {
          payload.senderName = 'unknown';
        }
      }
    } else if (data.bot_id) {
      const bot = this.client.getBotById(data.bot_id);
      payload.senderName = bot.name;
      payload.senderId = data.bot_id;
      payload.avatarUrl = bot.icons.image_72;
    }
    return payload;
  }
  
  sendFile(data) {
    let payload = <ThirdPartyImageMessagePayload>this.getPayload(data);
    payload.text = data.file.name;
    payload.url = ''; // to prevent errors
    return this.client.downloadImage(data.file.url_private).then(({ buffer, type }) => {
      payload.buffer = buffer;
      payload.mimetype = type;
      return this.puppetBridge.sendImageMessage(payload);
     }).catch((err) => {
      console.log(err);
      payload.text = '[Image] ('+data.name+') '+data.url;
      return this.puppetBridge.sendImageMessage(payload);
    });
  }
  
  createAndSendPayload(data) {
    const {
      channel,
      text,
      attachments,
      bot_id,
      user,
      user_profile,
      file,
    } = data;
    let messages = [text];
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
        .map(m => m.trim())
        .filter(m => m && (typeof m === "string"))
        .join('\n')
        .trim();
    let payload = <ThirdPartyMessagePayload>this.getPayload(data);
    
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
      ];
      for (let i = 0; i < replacements.length; i++) {
        rawMessage = rawMessage.replace(replacements[i][0], replacements[i][1]);
      }
      rawMessage = emojione.shortnameToUnicode(rawMessage);
      payload.text = slackdown(rawMessage, this.client.getUsers(), this.client.getChannels());
      payload.text = payload.text.replace(/;BEGIN_FONT_COLOR_HACK_(.*?);/g, '<font color="$1">');
      payload.text = payload.text.replace(/;END_FONT_COLOR_HACK;/g, '</font>');
      payload.html = converter.makeHtml(payload.text);
    } catch (e) {
      console.log(e);
      debug("could not normalize message", e);
      payload.text = rawMessage;
    }
    return this.puppetBridge.sendMessage(payload);
  }
  
  getUserData(id): Promise<UserData>{
    return Promise.resolve(() => {
      let uu = this.client.getUserById(id);
      let payload = <UserData>{
        name: id,
      };
      if (uu) {
        payload.name = uu.name;
        payload.avatarUrl = uu.profile.image_512;
      }
    });
  }
  
  getRoomData(id: string): Promise<RoomData> {
    return new Promise<RoomData>((resolve, reject) => {
      const room = this.client.getRoomById(id);
      if (!room) {
        return reject();
      }
      let payload = <RoomData>{
        name: '',
        topic: '',
        isDirect: room.isDirect
      };
      if (room.isDirect) {
        const uu = this.client.getUserById(room.user);
        if (uu) {
          payload.name = uu.name;
          payload.topic = `Slack Direct Message (Team: ${this.teamName})`
        }
      }
      if(!payload.name) {
        payload.name = room.name;
        payload.topic = room.purpose.value;
      }
      return resolve(payload);
    });
  }
  sendMessage(id, text) {
    debug('sending message as puppet to third party room with id', id);
    return this.client.sendMessage(text, id);
  }
  sendImageMessage(id, data) {
    return this.client.sendImageMessage(data.url, data.text, id);
  }
};