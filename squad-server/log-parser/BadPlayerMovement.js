export default {
  regex:
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNetPlayerMovement: Warning: ServerMove: TimeStamp expired: ([0-9.]+), CurrentTimeStamp: ([0-9.]+), Character: ([a-zA-Z0-9_]+)/,
  onMatch: (args, logParser) => {
    // try not to spam events
    if (logParser.eventStore.session['last-move-chain']) {
      if (logParser.eventStore.session['last-move-chain'] === args[2]) return;
    }

    logParser.eventStore.session['last-move-chain'] = args[2];

    const data = {
      raw: args[0],
      time: args[1],
      chainID: args[2],
      characterName: args[5],
      tse: parseFloat(args[3]),
      cts: parseFloat(args[4])
    };

    logParser.emit('SERVER-MOVE-WARN', data);
  }
};
