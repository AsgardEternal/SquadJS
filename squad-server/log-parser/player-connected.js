export default {
  regex:
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C .+PersistentLevel\.([^\s]+) \(IP: ([\d.]+) \| Online IDs: EOS: ([0-9a-f]{32}) steam: (\d+)\)/,
  onMatch: (args, logParser) => {
    const data = {
      raw: args[0],
      time: args[1],
      chainID: +args[2],
      ip: args[4],
      eosID: args[5],
      steamID: args[6]
    };

    const joinRequestData = logParser.eventStore.joinRequests[+args[2]];
    data.connection = joinRequestData.connection;
    data.playerSuffix = joinRequestData.suffix;
    data.playercontroller = joinRequestData.controller ? joinRequestData.controller : null;

    logParser.eventStore.players[data.steamID] = {
      ...logParser.eventStore.players[data.steamID],
      steamID: data.steamID,
      suffix: data.playerSuffix,
      controller: data.playercontroller
    };
    logParser.emit('PLAYER_CONNECTED', data);
  }
};
