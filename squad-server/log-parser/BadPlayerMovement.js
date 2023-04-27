export default {
  regex:
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNetPlayerMovement: Warning: ServerMove: TimeStamp expired: ([0-9.]+), CurrentTimeStamp: ([0-9.]+), Character: ([a-zA-Z0-9_]+)/,
  onMatch: (args, logParser) => {
    // try not to spam events
    if (logParser.eventStore.session['last-move-character']) {
      if (logParser.eventStore.session['last-move-character'] === args[5]) return;
    }

    logParser.eventStore.session['last-move-character'] = args[5];

    const data = {
      raw: args[0],
      time: args[1],
      chainID: args[2],
      characterName: args[5],
      tse: args[3],
      cts: args[4]
    };

    logParser.emit('SERVER-MOVE-WARN', data);
  }
};
