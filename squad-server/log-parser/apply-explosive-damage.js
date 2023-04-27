export default {
  regex:
    /^\[(([0-9.-]+):[0-9]+)]\[([ 0-9]+)]LogSquadTrace: \[DedicatedServer]ApplyExplosiveDamage\(\): HitActor=nullptr DamageCauser=[A-z0-9_]+ DamageInstigator=([A-z0-9_]+)/,
  onMatch: (args, logParser) => {
    const data = {
      raw: args[0],
      time: args[1],
      chainID: args[3],
      sectime: args[2],
      playercont: args[4]
    };

    if (logParser.eventStore.lastexplode) {
      if (logParser.eventStore.lastexplode.sectime === args[2]) {
        if (logParser.eventStore.lastexplode.chainID === args[3]) {
          if (logParser.eventStore.lastexplode.playercont === args[4]) {
            logParser.emit('EXPLODE-ATTACK', data);
          }
        }
      }
    }

    logParser.eventStore.lastexplode = data;
  }
};
