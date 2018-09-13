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
	opts = Object.assign({
		index: 'appmetrics',
		applicationName: process.argv[1]
	}, opts);

	const esClient = opts.esClient || new elasticsearch.Client(opts.esConfig);

	const startMonitoring = () => {
		const preConfigured = ['memory'];
		/*
		 * Memory is a special case as we change the structure of the data
		 */
		emitter.on('memory', (memory) => {
			const data = {
				'process': {
					'private':	memory.private,
					'physical':	memory.physical,
					'virtual':	memory.virtual,
				},
				'system': {
					'physical':	memory.physical_used,
					'total':	memory.physical_total
				}			
			};
			publishData('memory', memory.time, data);
		});
		
		const registerCallback = (value) => {
			/*
			 * Ignore memory as it's a special case (see above)
			 */
			if (preConfigured.indexOf(value.type) === -1) {
				emitter.on(value.type, (eventdata) => {
					const data = {};
					const properties = value.body.properties[value.type].properties;
					for (const prop of Object.keys(properties)) {
						data[prop] = eventdata[prop];
					}
					publishData(value.type, eventdata.time, data);
				});
			}
		};
		
		/*
		 * Register a callback for every event type we have a mapping for
		 */
		getJSONfromDir('mappings', registerCallback);		
	};

	/*
	 * Check to see if the appmetrics index exists in Elasticsearch. if
	 * is doesn't, then create the index to store the data into and
	 * upload the data type mappings
	 */
	esClient.indices.exists({ index: opts.index })
		.then(res => !res && esClient.indices.create({ index: opts.index })
			.then(() => putMappings(esClient, opts.index))
		)
		.catch(err => console.log('Failed to create index ' + opts.index))
		.then(startMonitoring);
	
	/*
	 * Check to see if there are any Kibana index format mappings for the index, if not:
	 * 1) Set the index format mappings
	 * 2) Upload default charts
	 * 3) Upload default dashboards
	 */
	esClient.search({
			index: '.kibana',
			type: 'index-pattern',
			size: 0,
			terminate_after: 1,
		})
		.catch((err) => {
			if (err.body.error.type === 'index_not_found_exception') {
				return esClient.indices.create({ index: '.kibana' })
					.then(() => ({ hits: { total: 0 } }));
			} else {
				throw err;
			}
		})
		.then((res) => {
			if (res.hits.total === 0) {
				putIndexes(esClient, opts.index);
				putCharts(esClient);
				putDashboards(esClient, opts.index);
			}
		});
	
	/*
	 * Publishing data to Elasticsearch (ES)
	 * This is done by writing data to a bulkarray, which is then bulk
	 * updated to ES on an interval timer.
	 */
	
	let bulkarray = [];

	const publishBulk = () => {
		esClient.bulk({
				index: opts.index,
				body: bulkarray
			})
//			.then(res => console.log('Published bulk update ' + res)
			.catch(err => console.log('Error doing bulk update ' + err))
	};

	const publishData = (type, time, data) => {
		const entry = {
			timestamp: new Date(time),
			hostName: os.hostname(),
			pid: process.pid,
			applicationName: opts.applicationName,
			[type]: data
		};
		bulkarray.push({ index: { _type: type } }, JSON.stringify(entry));
	};

	const bulkUpdater = setInterval(() => {
		if (bulkarray.length > 0) {
			publishBulk(bulkarray);
			bulkarray = [];
		}
	}, 5000);
	
	return emitter;
}

	
function getJSONfromDir(directory, callback) {
	const dirPath = path.join(__dirname, '..', directory); 
	fs.readdir(dirPath, (err, files) => {
		if (err) {
			console.log('Failed to read from ' + dirPath); 
		} else {
			for (const fileName of files) {
				const file = path.join(dirPath, fileName);
				callback.call(this, JSON.parse(fs.readFileSync(file, 'utf8')));
			}
		}
	});
}

/*
 * Put the mappings for the data we create into the index. It
 * shouldn't matter if we replace existing records as they should be the same...
 */
function putMappings(esClient, index) {
	getJSONfromDir('mappings', (mapping) => {
		esClient.indices.putMapping(Object.assign({}, mapping, { index }))
//			.then(res => console.log('Put mapping for ' + fileName))
			.catch(err => console.log('Failed to put mapping ' + err));
	});
}

function putIndexes(esClient, index) {
	getJSONfromDir('indexes', (indexDefinition) => {
		indexDefinition.id = index;
		indexDefinition.body.title = index;
		esClient.index(indexDefinition)
//			.then(res => console.log('Put index for ' + index))
			.catch(err => console.log('Failed to put index ' + err));
	});	
}

function putDashboards(esClient) {
	getJSONfromDir('dashboards', (dashboard) => {
		esClient.index(dashboard)
//			.then(res => console.log('Put dashboard for ' + dashboard))
			.catch(err => console.log('Failed to put dashboard ' + err));
	});	
}

function putCharts(esClient, index) {
	getJSONfromDir('charts', (chart) => {
		const { kibanaSavedObjectMeta } = chart.body;
		const searchSourceJSON = JSON.parse(kibanaSavedObjectMeta.searchSourceJSON);
		kibanaSavedObjectMeta.searchSourceJSON = JSON.stringify(Object.assign(searchSourceJSON, { index }));
		esClient.index(chart)
//			.then(res => console.log('Put chart for ' + chart))
			.catch(err => console.log('Failed to put chart ' + err));
	});	
}
