const debug = require('debug')('matrix-puppet:slack:app');
const { MatrixPuppetBridgeBase } = require("matrix-puppet-bridge");
const SlackClient = require('./client');
const slackdown = require('./slackdown');
const showdown  = require('showdown');
const converter = new showdown.Converter();

class App extends MatrixPuppetBridgeBase {
  setSlackTeam(teamName, userAccessToken) {
    this.teamName = teamName;
    this.userAccessToken = userAccessToken;
    this.slackPrefix = 'slack';
    this.servicePrefix = `${this.slackPrefix}_${this.teamName}`;
  }
  getServiceName() {
    return "Slack";
  }
  getServicePrefix() {
    return this.servicePrefix;
  }
  sendStatus(_msg) {
    let msg = `${this.teamName}: ${_msg}`
    this.sendStatusMsg({
      fixedWidthOutput: false,
      roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
    }, msg).catch((err)=>{
      console.log(err);
    });
  }
  initThirdPartyClient() {
    this.client = new SlackClient(this.userAccessToken);
    this.client.on('unable-to-start', (err)=>{
      this.sendStatus(`unable to start: ${err.message}`);
    });
    this.client.on('disconnected', ()=>{
      this.sendStatus('disconnected. will try to reconnect in a minute...');
      setTimeout(()=> {
        this.initThirdPartyClient().catch((err)=>{
          debug('reconnect failed with error', err.message);
          this.sendStatus('reconnnect failed with error', err.message);
        })
      }, 60 * 1000);
    });
    this.client.on('connected', (err)=>{
      this.sendStatus(`connected`);
    });
    return this.client.connect().then(()=>{
      debug('waiting a little bit for initial self-messages to fire before listening for messages');
      setTimeout(()=>this.registerMessageListener(), 5000);
    })
  }
  registerMessageListener() {
    this.client.on('message', (data)=>{
      const { channel, user, text, attachments, subtype, bot_id } = data;

      const isBotMessage = subtype === 'bot_message';

      // any direct text
      let messages = [text];

      // any attachments, stuff it into the text as new lines
      if (attachments) {
        attachments.forEach(att=>{
          debug('adding attachment', att);
          messages.push(att.text);
        });
      }

      const rawMessage = messages.join('\n').trim();

      let payload = { roomId: channel };

      try {
        payload.text = slackdown(rawMessage, this.client.getUsers(), this.client.getChannels());
        payload.html = converter.makeHtml(payload.text);
      } catch (e) {
        debug("could not normalize message", e);
        payload.text = rawMessage;
      }

      // lastly, determine the sender
      if (isBotMessage) {
        const bot = this.client.getBotById(bot_id);
        payload.senderName = bot.name;
        payload.senderId = bot_id;
        payload.avatarUrl = bot.icons.image_72
      } else {
        const isMe = user === this.client.getSelfUserId();
        payload.senderName = this.client.getUserById(user).name;
        payload.senderId = isMe ? undefined : user;
      }

      return this.handleThirdPartyRoomMessage(payload).catch(err=>{
        console.error(err);
      });
    });
    debug('registered message listener');
  }
  getThirdPartyRoomDataById(id) {
    const directTopic = () => `Slack Direct Message (Team: ${this.teamName})`
    const room = this.client.getRoomById(id);
    return {
      name: room.name ? room.name : "Room name unavailable",
      topic: room.isDirect ? directTopic() : room.purpose.value
    }
  }
  sendMessageAsPuppetToThirdPartyRoomWithId(id, text) {
    debug('sending message as puppet to third party room with id', id);
    return this.client.sendMessage(text, id);
  }
}

module.exports = App;
