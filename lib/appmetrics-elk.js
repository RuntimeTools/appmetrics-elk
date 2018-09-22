/*******************************************************************************
 * Copyright 2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *******************************************************************************/
'use strict';
const elasticsearch = require('elasticsearch');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function connector(emitter, opts) {
  opts = Object.assign(
    {
      index: 'appmetrics',
      app: process.argv[1],
    },
    opts
  );

  const esClient = opts.esClient || new elasticsearch.Client(opts.esConfig);

  let bulkarray = [];

  const preconfiguredEvents = ['memory'];

  /*
    * Memory is a special case as we change the structure of the data
    */
  emitter.on('memory', memory => {
    const data = {
      process: {
        private: memory.private,
        physical: memory.physical,
        virtual: memory.virtual,
      },
      system: {
        physical: memory.physical_used,
        total: memory.physical_total,
      },
    };
    publishData('memory', memory.time, data);
  });

  /*
   * Register a callback for every event type we have a mapping for
   */
  mapJsonInDir('mappings', (value, type) => {
    if (preconfiguredEvents.indexOf(type) !== -1) {
      return;
    }
    emitter.on(type, eventData => {
      const data = {};
      const { properties } = value.body.properties[type];
      for (const prop of Object.keys(properties)) {
        data[prop] = eventData[prop];
      }
      publishData(type, eventData.time, data);
    });
  });

  /*
   * Publishing data to Elasticsearch (ES)
   * This is done by writing data to a bulkarray, which is then bulk
   * updated to ES on an interval timer.
   */
  const publishData = (type, time, data) => {
    const action = { index: {} };
    const doc = {
      type,
      '@timestamp': new Date(time),
      host: os.hostname(),
      pid: process.pid,
      app: opts.app,
      [type]: data,
    };
    bulkarray.push(action, doc);
  };

  esClient
    .search({
      index: '.kibana',
      type: 'index-pattern',
      size: 0,
      terminate_after: 1,
    })
    .catch(err => {
      if (err.body.error.type !== 'index_not_found_exception') {
        throw err;
      }
      return esClient.indices.create({ index: '.kibana' }).then(() => ({ hits: { total: 0 } }));
    })
    .then(res =>
      esClient
        .info()
        .then(info => {
          const esVersion = Number(info.version.number.split('.')[0]);

          /*
           * Check to see if there are any Kibana index format mappings for the index, if not:
           * 1) Set the index format mappings
           * 2) Upload default charts
           * 3) Upload default dashboards
           */
          if (res.hits.total === 0) {
            putIndexes(esClient, esVersion, opts.index);
            putCharts(esClient, esVersion);
            putDashboards(esClient, esVersion, opts.index);
          }

          /*
           * Check to see if the appmetrics index exists in Elasticsearch. if
           * is doesn't, then create the index to store the data into and
           * upload the data type mappings
           */
          return esClient.indices
            .exists({ index: opts.index })
            .then(exists => !exists && esClient.indices.create({ index: opts.index }))
            .then(() => putMappings(esClient, esVersion, opts.index))
            .then(() => esVersion);
        })
        .catch(err => console.error('Failed to create index', err.stack))
    )
    .then(esVersion => {
      publishBulk(esClient, esVersion, opts.index, bulkarray);
      setInterval(publishBulk, 5000, esClient, esVersion, opts.index, bulkarray);
    });

  return emitter;
};

function mapJsonInDir(directory, callback) {
  const dirPath = path.join(__dirname, '..', directory);
  try {
    const files = fs.readdirSync(dirPath);
    for (const filename of files) {
      const file = path.join(dirPath, filename);
      const basename = path.basename(filename, '.json');
      callback(JSON.parse(fs.readFileSync(file, 'utf8')), basename);
    }
  } catch (err) {
    console.error('Failed to read from ' + dirPath);
    console.error(err);
  }
}

/*
 * Put the mappings for the data we create into the index. It
 * shouldn't matter if we replace existing records as they should be the same...
 */
function putMappings(esClient, esVersion, index) {
  mapJsonInDir('mappings', (mapping, type) => {
    mapping.index = index;
    if (esVersion <= 2) {
      backportFieldTypes(mapping);
    }
    if (esVersion <= 5) {
      mapping.type = type;
      delete mapping.body.properties.type;
    }
    esClient.indices
      .putMapping(mapping)
      // .then(res => console.log('Put mapping for ' + fileName))
      .catch(err => console.log('Failed to put mapping ' + err));
  });
}

function putIndexes(esClient, esVersion, index) {
  mapJsonInDir('indexes', indexPattern => {
    indexPattern.id = 'index-pattern:' + index;
    indexPattern.body[indexPattern.body.type].title = index;
    if (esVersion <= 5) {
      backportKibanaDoc(indexPattern);
    }
    esClient
      .index(indexPattern)
      // .then(res => console.log('Put index for ' + index))
      .catch(err => console.log('Failed to put index ' + err));
  });
}

function putDashboards(esClient, esVersion) {
  mapJsonInDir('dashboards', dashboard => {
    if (esVersion <= 5) {
      backportKibanaDoc(dashboard);
    }
    esClient
      .index(dashboard)
      // .then(res => console.log('Put dashboard for ' + dashboard))
      .catch(err => console.log('Failed to put dashboard ' + err));
  });
}

function putCharts(esClient, esVersion, index) {
  mapJsonInDir('charts', chart => {
    const { kibanaSavedObjectMeta } = chart.body[chart.body.type];
    const searchSourceJSON = JSON.parse(kibanaSavedObjectMeta.searchSourceJSON);
    searchSourceJSON.index = index;
    kibanaSavedObjectMeta.searchSourceJSON = JSON.stringify(searchSourceJSON);
    if (esVersion <= 5) {
      backportKibanaDoc(chart);
    }
    esClient
      .index(chart)
      // .then(res => console.log('Put chart for ' + chart))
      .catch(err => console.log('Failed to put chart ' + err));
  });
}

function publishBulk(esClient, esVersion, index, actions) {
  if (!actions.length) return;
  if (esVersion <= 5) {
    for (let i = 0; i < actions.length; i += 2) {
      actions[i].index._type = actions[i + 1].type;
      delete actions[i + 1].type;
    }
  }
  esClient
    .bulk({
      index,
      type: 'doc',
      body: actions,
    })
    // .then(res => console.log('Published bulk update ' + res)
    .catch(err => console.log('Error doing bulk update ' + err));
  actions.length = 0;
}

/*
 * Converts Kibana 6.x documents back to 2.x/5.x
 */
function backportKibanaDoc(doc) {
  doc.type = doc.body.type;
  /*
   * Strip the '{type}:' prefix from the id
   */
  doc.id = doc.id.slice(doc.body.type.length + 1);
  doc.body = doc.body[doc.body.type];
}

/*
 * Converts all 'text' and 'keyword' field types to their equivalent legacy types
 */
function backportFieldTypes(mapping) {
  if (!mapping) return;
  if (mapping.body) {
    return backportFieldTypes(mapping.body.properties);
  }
  for (const field of Object.keys(mapping)) {
    const value = mapping[field];
    switch (value.type) {
      case 'nested':
        backportFieldTypes(value.properties);
        break;
      case 'keyword':
        value.type = 'string';
        value.index = 'not_analyzed';
        break;
      case 'text':
        value.type = 'string';
        break;
    }
  }
}
