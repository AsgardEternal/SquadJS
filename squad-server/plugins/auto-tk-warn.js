import BasePlugin from './base-plugin.js';

export default class AutoTKWarn extends BasePlugin {
  static get description() {
    return 'The <code>AutoTkWarn</code> plugin will automatically warn players with a message when they teamkill.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      attackerMessage: {
        required: false,
        description: 'The message to warn attacking players with.',
        default: 'Please apologise for ALL TKs in ALL chat!'
      },
      victimMessage: {
        required: false,
        description: 'The message that will be sent to the victim.',
        default: null // 'You were killed by your own team.'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onTeamkill = this.onTeamkill.bind(this);
  }

  async mount() {
    this.server.on('TEAMKILL', this.onTeamkill);
  }

  async unmount() {
    this.server.removeEventListener('TEAMKILL', this.onTeamkill);
  }

  async onTeamkill(info) {
    let displaymsg = true;
    if (this.server.currentLayer) {
      if (this.server.currentLayer.gamemode === 'Seed') displaymsg = false;
      if (this.server.currentLayer.gamemode === 'Training') displaymsg = false;
    } else {
      if (this.server.currentLayerRcon.layer.includes('Seed')) displaymsg = false;
      if (this.server.currentLayerRcon.layer.includes('Training')) displaymsg = false;
    }
    if (info.attacker && this.options.attackerMessage && displaymsg) {
      this.server.rcon.warn(info.attacker.steamID, this.options.attackerMessage);
    }
    if (info.victim && this.options.victimMessage && displaymsg) {
      this.server.rcon.warn(info.victim.steamID, this.options.victimMessage);
    }
  }
}
