import axios from 'axios';

import Logger from 'core/logger';

import Layer from './layer.js';

class Layers {
  constructor() {
    this._layers = new Map();

    this.pulled = false;
  }

  get layers() {
    return [...this._layers.values()];
  }

  async pull(force = false) {
    if (this.pulled && !force) {
      Logger.verbose('Layers', 2, 'Already pulled layers.');
      return this.layers;
    }
    if (force) Logger.verbose('Layers', 1, 'Forcing update to layer information...');

    this._layers = new Map();

    Logger.verbose('Layers', 1, 'Pulling layers...');
    try {
      const response = await axios.get(
          'https://raw.githubusercontent.com/fantinodavide/SquadLayerList/main/layers.json'
      );
      for (const layer of response.data.Maps) {
        const newLayer = new Layer(layer);
        this._layers.set(newLayer.layerid, newLayer);
      }
      const response2 = await axios.get(
        'https://raw.githubusercontent.com/fantinodavide/SquadLayerList/main/mee.json'
      );
      for (const layer of response2.data.Maps) {
        const newLayer = new Layer(layer);
        this._layers.set(newLayer.layerid, newLayer);
      }
    } catch {
      Logger.verbose('Layers', 1, 'Failed to pull layer data from URL!');
    }

    //     const response = await axios.get(
    //       'https://raw.githubusercontent.com/Squad-Wiki/squad-wiki-pipeline-map-data/master/completed_output/_Current%20Version/finished.json'
    //     );


    Logger.verbose('Layers', 1, `Pulled ${this.layers.length} layers.`);

    this.pulled = true;

    return this.layers;
  }

  async getLayerByCondition(condition) {
    await this.pull();

    const matches = this.layers.filter(condition);
    if (matches.length >= 1) return matches[0];

    return null;
  }

  async getLayerById(layerId) {
    await this.pull();
    return this._layers.get(layerId) ?? null;
  }

  getLayerByName(name) {
    return this.getLayerByCondition((layer) => layer.name === name);
  }

  getLayerByClassname(classname) {
    return this.getLayerByCondition(
      (layer) =>
        layer.classname.replace(/_/, '').toLowerCase() === classname.replace(/_/, '').toLowerCase()
    );
  }
}

export default new Layers();
