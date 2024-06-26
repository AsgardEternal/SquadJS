import EventEmitter from 'events';

import axios from 'axios';

import Logger from 'core/logger';
import { SQUADJS_API_DOMAIN } from 'core/constants';

import { Layers } from './layers/index.js';

import LogParser from './log-parser/index.js';
import Rcon from './rcon.js';

import { SQUADJS_VERSION } from './utils/constants.js';

import fetchAdminLists from './utils/admin-lists.js';

export default class SquadServer extends EventEmitter {
  constructor(options = {}) {
    super();

    for (const option of ['host'])
      if (!(option in options)) throw new Error(`${option} must be specified.`);

    this.id = options.id;
    this.options = options;

    this.layerHistory = [];
    this.layerHistoryMaxLength = options.layerHistoryMaxLength || 20;

    this.players = [];
    this.playerinfo = new Map();

    this.squads = [];

    this.admins = {};
    this.adminsInAdminCam = {};

    this.plugins = [];

    this.setupRCON();
    this.setupLogParser();

    this.updatePlayerList = this.updatePlayerList.bind(this);
    this.updatePlayerListInterval = 30 * 1000;
    this.updatePlayerListTimeout = null;

    this.updateSquadList = this.updateSquadList.bind(this);
    this.updateSquadListInterval = 30 * 1000;
    this.updateSquadListTimeout = null;

    this.updateLayerInformation = this.updateLayerInformation.bind(this);
    this.updateLayerInformationInterval = 30 * 1000;
    this.updateLayerInformationTimeout = null;

    this.updateA2SInformation = this.updateA2SInformation.bind(this);
    this.updateA2SInformationInterval = 30 * 1000;
    this.updateA2SInformationTimeout = null;

    this.pingSquadJSAPI = this.pingSquadJSAPI.bind(this);
    this.pingSquadJSAPIInterval = 5 * 60 * 1000;
    this.pingSquadJSAPITimeout = null;
  }

  async watch() {
    Logger.verbose(
      'SquadServer',
      1,
      `Beginning to watch ${this.options.host}:${this.options.queryPort}...`
    );

    await Layers.pull();

    this.admins = await fetchAdminLists(this.options.adminLists);

    await this.rcon.connect();
    await this.updateLayerList();
    await this.logParser.watch();

    await this.updateSquadList();
    await this.updatePlayerList(this);
    await this.updateLayerInformation();
    await this.updateA2SInformation();

    await this.logParser.watch();

    Logger.verbose('SquadServer', 1, `Watching ${this.serverName}...`);

    await this.pingSquadJSAPI();
  }

  async unwatch() {
    await this.rcon.disconnect();
    await this.logParser.unwatch();
  }

  setupRCON() {
    this.rcon = new Rcon({
      host: this.options.rconHost || this.options.host,
      port: this.options.rconPort,
      password: this.options.rconPassword,
      autoReconnectInterval: this.options.rconAutoReconnectInterval,
      dumpRconResponsesToFile: this.options.dumpRconResponsesToFile,
      passThroughPort: this.options.rconPassThroughPort,
      passThrough: this.options.rconPassThrough
    });

    this.rcon.on('CHAT_MESSAGE', async (data) => {
      data.player = await this.getPlayerBySteamID(data.steamID);
      this.emit('CHAT_MESSAGE', data);

      const command = data.message.match(/!([^ ]+) ?(.*)/);
      if (command)
        this.emit(`CHAT_COMMAND:${command[1].toLowerCase()}`, {
          ...data,
          message: command[2].trim()
        });
    });

    this.rcon.on('POSSESSED_ADMIN_CAMERA', async (data) => {
      data.player = await this.getPlayerBySteamID(data.steamID);

      this.adminsInAdminCam[data.steamID] = data.time;

      this.emit('POSSESSED_ADMIN_CAMERA', data);
    });

    this.rcon.on('UNPOSSESSED_ADMIN_CAMERA', async (data) => {
      data.player = await this.getPlayerBySteamID(data.steamID);
      if (this.adminsInAdminCam[data.steamID]) {
        data.duration = data.time.getTime() - this.adminsInAdminCam[data.steamID].getTime();
      } else {
        data.duration = 0;
      }

      delete this.adminsInAdminCam[data.steamID];

      this.emit('UNPOSSESSED_ADMIN_CAMERA', data);
    });

    this.rcon.on('RCON_ERROR', (data) => {
      this.emit('RCON_ERROR', data);
    });

    this.rcon.on('PLAYER_WARNED', async (data) => {
      data.player = await this.getPlayerByName(data.name);

      this.emit('PLAYER_WARNED', data);
    });

    this.rcon.on('PLAYER_KICKED', async (data) => {
      data.player = await this.getPlayerBySteamID(data.steamID);

      this.emit('PLAYER_KICKED', data);
    });

    this.rcon.on('PLAYER_BANNED', async (data) => {
      data.player = await this.getPlayerBySteamID(data.steamID);

      this.emit('PLAYER_BANNED', data);
    });

    this.rcon.on('SQUAD_CREATED', async (data) => {
      data.player = await this.getPlayerBySteamID(data.playerSteamID, true);
      data.player.squadID = data.squadID;

      delete data.playerName;
      delete data.playerSteamID;

      this.emit('SQUAD_CREATED', data);
    });
  }

  async restartRCON() {
    try {
      await this.rcon.disconnect();
    } catch (err) {
      Logger.verbose('SquadServer', 1, 'Failed to stop RCON instance when restarting.', err);
    }

    Logger.verbose('SquadServer', 1, 'Setting up new RCON instance...');
    this.setupRCON();
    await this.rcon.connect();
  }

  setupLogParser() {
    this.logParser = new LogParser(
      Object.assign(this.options.ftp, {
        mode: this.options.logReaderMode,
        logDir: this.options.logDir,
        host: this.options.ftp.host || this.options.host
      })
    );

    this.logParser.on('ADMIN_BROADCAST', (data) => {
      this.emit('ADMIN_BROADCAST', data);
    });

    this.logParser.on('DEPLOYABLE_DAMAGED', async (data) => {
      data.player = await this.getPlayerByNameSuffix(data.playerSuffix);

      delete data.playerSuffix;

      this.emit('DEPLOYABLE_DAMAGED', data);
    });

    this.logParser.on('NEW_GAME', async (data) => {
      data.layer = await Layers.getLayerByClassname(data.layerClassname);

      this.layerHistory.unshift({ layer: data.layer, time: data.time });
      this.layerHistory = this.layerHistory.slice(0, this.layerHistoryMaxLength);

      this.currentLayer = data.layer;
      Logger.verbose('layerupdate', 1, `Log parser setting layer to ${this.currentLayer?.layerid}`);
      await this.updateAdmins();
      this.emit('NEW_GAME', data);
    });

    this.logParser.on('ROUND_ENDED', async (data) => {
      const datalayer = data.winner ? await Layers.getLayerById(data.winner.layer) : null;
      const outdata = {
        rawData: data,
        rawLayer: data.winner ? data.winner.layer : null,
        rawLevel: data.winner ? data.winner.level : null,
        time: data.time,
        winnerId: data.winner ? data.winner.team : null,
        winnerFaction: data.winner ? data.winner.faction : null,
        winnerTickets: data.winner ? data.winner.tickets : null,
        loserId: data.loser ? data.loser.team : null,
        loserFaction: data.loser ? data.loser.faction : null,
        loserTickets: data.loser ? data.loser.tickets : null,
        layer: datalayer
      };

      this.emit('ROUND_ENDED', outdata);
    });

    this.logParser.on('PLAYER_CONNECTED', async (data) => {
      Logger.verbose(
        'SquadServer',
        1,
        `Player connected ${data.playerSuffix} - SteamID: ${data.steamID} - EOSID: ${data.eosID}`
      );

      this.rcon.addIds(data.steamID, data.eosID);

      data.player = await this.getPlayerByEOSID(data.eosID);
      if (data.player) data.player.suffix = data.playerSuffix;
      else {
          Logger.verbose('updatePlayerList', 1, `ERROR: failed to get player by RCON for ${data.steamID},${data.playerSuffix}`);
          data.player = {
              steamID: data.steamID,
              name: data.playerSuffix,
              suffix: data.playerSuffix,
              eosID: data.eosID
          }
      }

      delete data.steamID;
      delete data.playerSuffix;

      this.emit('PLAYER_CONNECTED', data);
    });

    this.logParser.on('PLAYER_DISCONNECTED', async (data) => {
        Logger.verbose('PlayerBugFix', 1, `player ${data.playerEOSID} disconnect with playerinfo: ${JSON.stringify(Array.from(this.playerinfo.entries()))}`);
        data.player = await this.getPlayerByEOSID(data.playerEOSID);

        if(!data.player){
            Logger.verbose('PlayerBugFix', 1, `Bug detected, using playerinfo data for ${data.steamID}`);
            data.player = this.playerinfo.get(data.playerEOSID);
        }
        if (!data.player){
            Logger.verbose('PlayerBugFix', 1, `Bug detected, FAILED, falling back for ${data.steamID}`);
            data.player = {
                steamID: this.rcon.eosIndex[data.playerEOSID],
                eosID: data.playerEOSID
            };
        }
      this.playerinfo.delete(data.playerEOSID);

      this.emit('PLAYER_DISCONNECTED', data);
    });

    this.logParser.on('PLAYER_DAMAGED', async (data) => {
      data.victim = await this.getPlayerByName(data.victimName);
      data.attacker = await this.getPlayerByEOSID(data.attackerEOSID);

      if (!data.attacker.playercontroller) data.attacker.playercontroller = data.attackerController;

      if (data.victim && data.attacker) {
          if (!data.victim.playercontroller) data.victim.playercontroller = data.attackerController;
        data.teamkill =
          data.victim.teamID === data.attacker.teamID &&
          data.victim.steamID !== data.attacker.steamID;
      }

      delete data.victimName;
      delete data.attackerName;

      this.emit('PLAYER_DAMAGED', data);
    });

    this.logParser.on('PLAYER_WOUNDED', async (data) => {
      data.victim = await this.getPlayerByName(data.victimName);
      data.attacker = await this.getPlayerByEOSID(data.attackerEOSID);
      if (!data.attacker)
        data.attacker = await this.getPlayerByController(data.attackerPlayerController);

      if (data.victim && data.attacker)
        data.teamkill =
          data.victim.teamID === data.attacker.teamID &&
          data.victim.steamID !== data.attacker.steamID;

      this.emit('PLAYER_WOUNDED', data);
      if (data.teamkill) this.emit('TEAMKILL', data);
    });

    this.logParser.on('PLAYER_DIED', async (data) => {
      data.victim = await this.getPlayerByName(data.victimName);
      data.attacker = await this.getPlayerByEOSID(data.attackerEOSID);
      if (!data.attacker)
        data.attacker = await this.getPlayerByController(data.attackerPlayerController);

      if (data.victim && data.attacker)
        data.teamkill =
          data.victim.teamID === data.attacker.teamID &&
          data.victim.steamID !== data.attacker.steamID;

      // console.log(data);

      this.emit('PLAYER_DIED', data);
    });

    this.logParser.on('PLAYER_REVIVED', async (data) => {
      data.victim = await this.getPlayerByEOSID(data.victimEOSID);
      data.attacker = await this.getPlayerByEOSID(data.attackerEOSID);
      data.reviver = await this.getPlayerByEOSID(data.reviverEOSID);

      delete data.victimName;
      delete data.attackerName;
      delete data.reviverName;

      this.emit('PLAYER_REVIVED', data);
    });

    this.logParser.on('PLAYER_POSSESS', async (data) => {
      data.player = await this.getPlayerByEOSID(data.playerEOSID);
      if (data.player) data.player.possessClassname = data.possessClassname;
      if (data.player) data.player.characterClassname = data.characterClassname;

      delete data.playerSuffix;

      this.emit('PLAYER_POSSESS', data);
    });

    this.logParser.on('PLAYER_UNPOSSESS', async (data) => {
      data.player = await this.getPlayerByEOSID(data.playerEOSID);

      delete data.playerSuffix;

      this.emit('PLAYER_UNPOSSESS', data);
    });

    this.logParser.on('SERVER-MOVE-WARN', async (data) => {
      const tsd = data.tse - data.cts;
      Logger.verbose('ServerMoveWarn', 1, 'tsd value: ' + tsd);

      const outdata = {
        raw: data.raw,
        time: data.time,
        rawID: data.characterName,
        cheatType: 'Remote Actions',
        player: await this.getPlayerByClassname(data.characterName),
        probcheat: data.cts < 2 ? 'unlikely' : null,
        probcolor: data.cts < 2 ? 0xffff00 : null
      };

      if ((tsd < 235 && tsd > 0) || tsd < -100) this.emit('PLAYER-CHEAT', outdata);
    });

    this.logParser.on('EXPLODE-ATTACK', async (data) => {
      const outdata = {
        raw: data.raw,
        time: data.time,
        rawID: data.playercont,
        cheatType: 'Explosion attack',
        player: await this.getPlayerByController(data.playercont)
      };

      this.emit('PLAYER-CHEAT', outdata);
    });

    this.logParser.on('TICK_RATE', (data) => {
      this.emit('TICK_RATE', data);
    });

    this.logParser.on('CLIENT_EXTERNAL_ACCOUNT_INFO', (data) => {
      this.rcon.addIds(data.steamID, data.eosID);
    });
    // this.logParser.on('CLIENT_CONNECTED', (data) => {
    //   Logger.verbose("SquadServer", 1, `Client connected. Connection: ${data.connection} - SteamID: ${data.steamID}`)
    // })
    // this.logParser.on('CLIENT_LOGIN_REQUEST', (data) => {
    //   Logger.verbose("SquadServer", 1, `Login request. ChainID: ${data.chainID} - Suffix: ${data.suffix} - EOSID: ${data.eosID}`)

    // })
    // this.logParser.on('RESOLVED_EOS_ID', (data) => {
    //   Logger.verbose("SquadServer", 1, `Resolved EOSID. ChainID: ${data.chainID} - Suffix: ${data.suffix} - EOSID: ${data.eosID}`)
    // })
    // this.logParser.on('ADDING_CLIENT_CONNECTION', (data) => {
    //   Logger.verbose("SquadServer", 1, `Adding client connection`, data)
    // })
  }

  async restartLogParser() {
    try {
      await this.logParser.unwatch();
    } catch (err) {
      Logger.verbose('SquadServer', 1, 'Failed to stop LogParser instance when restarting.', err);
    }

    Logger.verbose('SquadServer', 1, 'Setting up new LogParser instance...');
    this.setupLogParser();
    await this.logParser.watch();
  }

  getAdminPermsBySteamID(steamID) {
    return this.admins[steamID];
  }

  getAdminsWithPermission(perm) {
    const ret = [];
    for (const [steamID, perms] of Object.entries(this.admins)) {
      if (perm in perms) ret.push(steamID);
    }
    return ret;
  }

  async updateAdmins() {
    this.admins = await fetchAdminLists(this.options.adminLists);
  }

  async updatePlayerList() {
    if (this.updatePlayerListTimeout) clearTimeout(this.updatePlayerListTimeout);

    Logger.verbose('SquadServer', 1, `Updating player list...`);

    try {
      const oldPlayerInfo = new Map();
      for (const player of this.players) {
        oldPlayerInfo.set(player.eosID, player);
      }

      const players = [];
      Logger.verbose('updatePlayerList',1,`eventstore player data: ${JSON.stringify(this.logParser.eventStore.players)}`);
      for (const player of await this.rcon.getListPlayers()){
        players.push({
          ...oldPlayerInfo.get(player.eosID),
          ...player,
          playercontroller: this.logParser.eventStore.players[player.steamID]
            ? this.logParser.eventStore.players[player.steamID].controller
            : null,
          squad: await this.getSquadByID(player.teamID, player.squadID)
        });
      }

      this.players = players;
      for (const player of players) {
        this.playerinfo.set(player.eosID, player);
      }

      for (const player of this.players) {
        const oldplayer = oldPlayerInfo.get(player.eosID);
        if (!oldplayer) continue;
        if (player.name !== oldplayer.name)
          this.emit('PLAYER_NAME_CHANGE', {
            player: player,
            oldName: oldplayer.name,
            newName: player.name
          });
        if (player.teamID !== oldplayer.teamID)
          this.emit('PLAYER_TEAM_CHANGE', {
            player: player,
            oldTeamID: oldplayer.teamID,
            newTeamID: player.teamID
          });
        if (player.squadID !== oldplayer.squadID)
          this.emit('PLAYER_SQUAD_CHANGE', {
            player: player,
            oldSquadID: oldplayer.squadID,
            newSquadID: player.squadID
          });
      }

      if (this.a2sPlayerCount > 0 && players.length === 0)
        Logger.verbose(
          'SquadServer',
          1,
          `Real Player Count: ${this.a2sPlayerCount} but loaded ${players.length}`
        );

      this.emit('UPDATED_PLAYER_INFORMATION');
    } catch (err) {
      Logger.verbose('SquadServer', 1, 'Failed to update player list.', err);
    }

    Logger.verbose('SquadServer', 1, `Updated player list.`);

    this.updatePlayerListTimeout = setTimeout(this.updatePlayerList, this.updatePlayerListInterval);
  }

  async updateSquadList() {
    if (this.updateSquadListTimeout) clearTimeout(this.updateSquadListTimeout);

    Logger.verbose('SquadServer', 1, `Updating squad list...`);

    try {
      this.squads = await this.rcon.getSquads();
    } catch (err) {
      Logger.verbose('SquadServer', 1, 'Failed to update squad list.', err);
    }

    Logger.verbose('SquadServer', 1, `Updated squad list.`);

    this.updateSquadListTimeout = setTimeout(this.updateSquadList, this.updateSquadListInterval);
  }

  async updateLayerInformation() {
    if (this.updateLayerInformationTimeout) clearTimeout(this.updateLayerInformationTimeout);

    Logger.verbose('SquadServer', 1, `Updating layer information...`);

    try {
      let currentLayer = this.currentLayer;
      const currentMap = await this.rcon.getCurrentMap();
      const nextMap = await this.rcon.getNextMap();
      const nextMapToBeVoted = nextMap.layer === 'To be voted';

      Logger.verbose(
        'layerupdate',
        1,
        'curlay name:' + currentLayer?.name + ', rcon name:' + currentMap.layer
      );
      if (currentLayer?.name !== currentMap.layer) {
        let rconlayer = await Layers.getLayerByName(currentMap.layer);
        if (!rconlayer) rconlayer = await Layers.getLayerById(currentMap.layer);
        if (!rconlayer) rconlayer = await Layers.getLayerByClassname(currentMap.layer);

        if (rconlayer && currentMap.layer !== "Jensen's Training Range") {
          currentLayer = rconlayer;
          Logger.verbose(
            'layerupdate',
            1,
            `RCON is setting Layer information to ${rconlayer.layerid}`
          );
        }
      }
      if (currentLayer) Logger.verbose('layerupdate', 1, 'Found Current layer');
      else Logger.verbose('layerupdate', 1, 'WARNING: Could not find layer from RCON');

      const nextLayer = nextMapToBeVoted ? null : await Layers.getLayerByName(nextMap.layer);

      if (this.layerHistory.length === 0) {
        this.layerHistory.unshift({ layer: currentLayer, time: Date.now() });
        this.layerHistory = this.layerHistory.slice(0, this.layerHistoryMaxLength);
      }

      this.currentLayer = currentLayer;
      this.nextLayer = nextLayer;
      this.nextLayerToBeVoted = nextMapToBeVoted;

      this.emit('UPDATED_LAYER_INFORMATION');
    } catch (err) {
      Logger.verbose('SquadServer', 1, 'Failed to update layer information.', err);
    }

    Logger.verbose('SquadServer', 1, `Updated layer information.`);

    this.updateLayerInformationTimeout = setTimeout(
      this.updateLayerInformation,
      this.updateLayerInformationInterval
    );
  }

  async updateA2SInformation() {
    if (this.updateA2SInformationTimeout) clearTimeout(this.updateA2SInformationTimeout);

    Logger.verbose('SquadServer', 1, `Updating A2S information...`);

    const serverlayer = this.currentLayer;
    try {
      // const data = await Gamedig.query({
      //   type: 'squad',
      //   host: this.options.host,
      //   port: this.options.queryPort
      // });

      const rawData = await this.rcon.execute(`ShowServerInfo`);
      Logger.verbose('SquadServer', 3, `A2S raw data`, rawData);
      const data = JSON.parse(rawData);
      Logger.verbose('SquadServer', 2, `A2S data`, JSON.data);
      // Logger.verbose("SquadServer", 1, `A2S data`, JSON.stringify(data, null, 2))

      const info = {
        raw: data,
        serverName: data.ServerName_s,

        maxPlayers: parseInt(data.MaxPlayers),
        publicQueueLimit: parseInt(data.PublicQueueLimit_I),
        reserveSlots: parseInt(data.PlayerReserveCount_I),

        playerCount: parseInt(data.PlayerCount_I),
        a2sPlayerCount: parseInt(data.PlayerCount_I),
        publicQueue: parseInt(data.PublicQueue_I),
        reserveQueue: parseInt(data.ReservedQueue_I),

        currentLayer: data.MapName_s,
        nextLayer: data.NextLayer_s,

        teamOne: data.TeamOne_s?.replace(new RegExp(data.MapName_s, 'i'), '') || '',
        teamTwo: data.TeamTwo_s?.replace(new RegExp(data.MapName_s, 'i'), '') || '',

        matchTimeout: parseFloat(data.MatchTimeout_d),
        gameVersion: data.GameVersion_s
      };

      this.serverName = info.serverName;

      this.maxPlayers = info.maxPlayers;
      this.publicSlots = info.maxPlayers - info.reserveSlots;
      this.reserveSlots = info.reserveSlots;

      this.a2sPlayerCount = info.playerCount;
      this.publicQueue = info.publicQueue;
      this.reserveQueue = info.reserveQueue;

      this.matchTimeout = info.matchTimeout;
      this.gameVersion = info.gameVersion;

      Logger.verbose(
        'layerupdate',
        1,
        'a2smsg' + info.currentLayer + ', current id:' + serverlayer?.layerid
      );
      if (info.currentLayer !== serverlayer?.layerid) {
        const a2slayer = await Layers.getLayerById(info.currentLayer);
        this.currentLayer = a2slayer || this.currentLayer;
        Logger.verbose(
          'layerupdate',
          1,
          `A2S is setting Layer information to ${this.currentLayer?.layerid}`
        );
      }

      this.emit('UPDATED_A2S_INFORMATION', info);
      this.emit('UPDATED_SERVER_INFORMATION', info);
    } catch (err) {
      Logger.verbose('SquadServer', 1, 'Failed to update A2S information.', err);
    }

    Logger.verbose('SquadServer', 1, `Updated A2S information.`);

    this.updateA2SInformationTimeout = setTimeout(
      this.updateA2SInformation,
      this.updateA2SInformationInterval
    );
  }

  async updateLayerList() {
    // update expected list from http source
    await Layers.pull();

    // grab layers actually available through rcon
    const rconRaw = (await this.rcon.execute('ListLayers'))?.split('\n') || [];
    // take out first result, not actual layer just a header
    rconRaw.shift();

    // filter out raw result from RCON, modded layers have a suffix that needs filtering
    const rconLayers = [];
    for (const raw of rconRaw) {
      rconLayers.push(raw.split(' ')[0]);
    }

    // go through http layers and delete any that don't show up in rcon
    for (const layer of Layers.layers) {
      if (!rconLayers.find((e) => e === layer.layerid)) Layers._layers.delete(layer.layerid);
    }

    // add layers that are in RCON that we did not find in the http list
    for (const layer of rconLayers) {
      if (!Layers.layers.find((e) => e?.layerid === layer)) {
        const newLayer = this.mapLayer(layer);
        if (!newLayer) continue;
        // Logger.verbose('LayerUpdater', 1, 'Created RCON Layer: ', newLayer);
        Layers._layers.set(newLayer.layerid, newLayer);
      }
    }

    for (const layer of Layers.layers) {
      Logger.verbose('LayerUpdater', 1, 'Found layer: ' + layer.layerid + ' - ' + layer.name);
    }
  }

  // helper for updateLayerList
  mapLayer(layid) {
    layid = layid.replace(/[^\da-z_-]/gi, '');
    const gl =
      /^((?<mod>[A-Z]+)_)?(?<level>[A-Za-z_]+?)_((?<gamemode>[A-Za-z]+)(_|$))?((?<version>[vV][0-9]+(-\w)?|[DN])(_|$))?((?<team1>[a-zA-Z0-9]+)[-v_](?<team2>[a-zA-Z0-9]+))?(_CQB)?$/gm.exec(
        layid
      )?.groups;
    if (!gl) return;

    const teams = [];
    // eslint-disable-next-line no-unused-vars
    for (const t of ['team1', 'team2']) {
      teams.push({
        tickets: 0,
        commander: false,
        vehicles: [],
        numberOfTanks: 0,
        numberOfHelicopters: 0
      });
    }
    teams[0].faction = gl.team1 ? gl.team1 : 'Unknown';
    teams[0].name = gl.team1 ? gl.team1 : 'Unknown';
    teams[1].faction = gl.team2 ? gl.team2 : 'Unknown';
    teams[1].name = gl.team2 ? gl.team2 : 'Unknown';

    return {
      name: layid.replace(/_/g, ' '),
      classname: gl.level,
      layerid: layid,
      modName: gl.mod ? gl.mod : 'Vanilla',
      map: {
        name: gl.level
      },
      gamemode: gl.gamemode ? gl.gamemode : 'Training',
      gamemodeType: gl.gamemode ? gl.gamemode : 'Training',
      version: gl.version ? gl.version : 'v0',
      size: '0.0x0.0 km',
      sizeType: 'Playable Area',
      numberOfCapturePoints: 0,
      lighting: {
        name: 'Unknown',
        classname: 'Unknown'
      },
      teams: teams
    };
  }

  async getPlayerByCondition(condition, forceUpdate = false, retry = false) {
    let matches;

    if (!forceUpdate) {
      Logger.verbose('updatePlayerList', 1, `trying to get condition ${condition.toString()}`);
      matches = this.players.filter(condition);
      if (matches.length === 1) return matches[0];
      Logger.verbose('updatePlayerList', 1, `ERROR: failed to find player ${JSON.stringify(condition)}, matches found: ${matches.length}`);
      Logger.verbose('updatePlayerList', 1, `this.players: ${JSON.stringify(this.players)}`);
      if (!retry) return null;
    }

    // await this.updatePlayerList();
    Logger.verbose('updatePlayerList', 1, 'ERROR: attempted to update player list through RCON');

    matches = this.players.filter(condition);
    if (matches.length === 1) return matches[0];

    return null;
  }

  async getSquadByCondition(condition, forceUpdate = false, retry = false) {
    let matches;

    if (!forceUpdate) {
      matches = this.squads.filter(condition);
      if (matches.length === 1) return matches[0];
      Logger.verbose('updateSquadList', 1, `ERROR: failed to find squad ${JSON.stringify(condition)}, matches found: ${matches.length}`);
      if (!retry) return null;
    }

    // await this.updateSquadList();

    matches = this.squads.filter(condition);
    if (matches.length === 1) return matches[0];

    return null;
  }

  async getSquadByID(teamID, squadID) {
    if (squadID == null || teamID == null) return null;
    return this.getSquadByCondition(
      (squad) => squad.teamID === teamID && squad.squadID === squadID
    );
  }

  async getPlayerBySteamID(steamID, forceUpdate) {
    if (steamID == null) return null;
    return this.getPlayerByCondition((player) => player.steamID === steamID, forceUpdate);
  }

  async getPlayerByEOSID(eosID, forceUpdate) {
    if (eosID == null) return null;
    return this.getPlayerByCondition((player) => player.EOSID === eosID, forceUpdate);
  }

  async getPlayerByName(name, forceUpdate) {
    if (name == null) return null;
    return this.getPlayerByCondition((player) => player.name === name, forceUpdate);
  }

  async getPlayerByNameSuffix(suffix, forceUpdate) {
    if (suffix == null) return null;
    return this.getPlayerByCondition((player) => player.suffix === suffix, forceUpdate, false);
  }

  async getPlayerByController(controller, forceUpdate) {
    if (controller == null) return null;
    return this.getPlayerByCondition((player) => player.playercontroller === controller, forceUpdate);
  }

  async getPlayerByClassname(classname, forceUpdate){
    if (classname == null) return null;
    return this.getPlayerByCondition((player) => player.classname === classname, forceUpdate);
  }

  async pingSquadJSAPI() {

    // noinspection UnreachableCodeJS
    // if (this.pingSquadJSAPITimeout) clearTimeout(this.pingSquadJSAPITimeout);

  //   Logger.verbose('SquadServer', 1, 'Pinging SquadJS API...');
  //
  //   const payload = {
  //     // Send information about the server.
  //     server: {
  //       host: this.options.host,
  //       queryPort: this.options.queryPort,
  //
  //       name: this.serverName,
  //       playerCount: this.a2sPlayerCount + this.publicQueue + this.reserveQueue
  //     },
  //
  //     // Send information about SquadJS.
  //     squadjs: {
  //       version: SQUADJS_VERSION,
  //       logReaderMode: this.options.logReaderMode,
  //
  //       // Send the plugin config so we can see what plugins they're using (none of the config is sensitive).
  //       plugins: this.plugins.map((plugin) => ({
  //         ...plugin.rawOptions,
  //         plugin: plugin.constructor.name
  //       }))
  //     }
  //   };
  //
  //   try {
  //     const { data } = await axios.post(SQUADJS_API_DOMAIN + '/api/v1/ping', payload);
  //
  //     if (data.error)
  //       Logger.verbose(
  //         'SquadServer',
  //         1,
  //         `Successfully pinged the SquadJS API. Got back error: ${data.error}`
  //       );
  //     else
  //       Logger.verbose(
  //         'SquadServer',
  //         1,
  //         `Successfully pinged the SquadJS API. Got back message: ${data.message}`
  //       );
  //   } catch (err) {
  //     Logger.verbose('SquadServer', 1, 'Failed to ping the SquadJS API: ', err.message);
  //   }
  //
  //   this.pingSquadJSAPITimeout = setTimeout(this.pingSquadJSAPI, this.pingSquadJSAPIInterval);
  }
}
