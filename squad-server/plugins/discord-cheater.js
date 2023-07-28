import DiscordBasePlugin from './discord-base-plugin.js';

export default class DiscordCheater extends DiscordBasePlugin {
  static get description() {
    return 'The <code>DiscordCheater</code> plugin will send any suspected cheating to a Discord channel.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the channel to log admin broadcasts to.',
        default: '',
        example: '667741905228136459'
      },
      color: {
        required: false,
        description: 'The color of the embed.',
        default: 0xff0000
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.cheat = this.cheat.bind(this);
  }

  async mount() {
    this.server.on('PLAYER-CHEAT', this.cheat);
  }

  async unmount() {
    this.server.removeEventListener('PLAYER-CHEAT', this.cheat);
  }

  async cheat(info) {
    await this.sendDiscordMessage({
      embed: {
        title: 'Suspected Cheater',
        color: info.probcolor ? info.probcolor : this.options.color,
        fields: [
          {
            name: 'Player Name',
            value: info.player ? info.player.name : 'Unkown Name',
            inline: true
          },
          {
            name: 'SteamID',
            value: info.player
              ? `[${info.player.steamID}](https://steamcommunity.com/profiles/${info.player.steamID})`
              : 'Unkown steamID',
            inline: true
          },
          {
            name: 'Player Raw ID (give to Skillet)',
            value: info.rawID ? info.rawID : 'Unknown ID'
          },
          {
            name: 'raw log string (give to Skillet)',
            value: info.raw ? info.raw : 'Unkown'
          },
          {
            name: 'Type of Cheating',
            value: info.cheatType
          },
          {
            name: 'Probibility of cheating',
            value: info.probcheat ? info.probcheat : 'high',
            inline: true
          }
        ],
        timestamp: info.time ? info.time.toISOString() : 'Unkown'
      }
    });
    if(info.probcheat==='high'){
      this.server.rcon.kick(info.player.steamID, 'R14 | Cheating - highly suspected');
    }
  }
}
