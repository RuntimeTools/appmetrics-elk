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
var os = require('os');

var INDEX = 'appmetrics';
var APPNAME = process.argv[1];
var HOSTNAME = os.hostname();
var PID = process.pid;

var monitor = function (opts) {
	var appmetrics = require('appmetrics');
    var monitor = appmetrics.monitor();
    
    if (typeof(opts) !== 'undefined') {
    	if (typeof(opts.index) !== 'undefined') {
    		INDEX = opts.index;
    		delete opts.index;
    	}
    	if (typeof(opts.applicationName) !== 'undefined') {
    		APPNAME = opts.applicationName;
    		delete opts.applicationName;
    	}
    }

    var elasticsearch = require('elasticsearch');
    var esearch = elasticsearch.Client(opts);
    
    /*
     * Check to see if the appmetrics index exists in ElasticSearch. if
     * is doesn't, then create the index to store the data into and
     * upload the data type mappings
     */
    esearch.indices.exists({
    	'index':	INDEX
    }, function (err, res){
    	if (res === false) {
    	    esearch.indices.create({
    	    	'index':	INDEX
    	    }, function (err, res) { 
    	    	putMappings(esearch, INDEX);
    	    });
    	}
    	startMonitoring();
    });
    
    /*
     * Check to see if the Kibana indexes exist. If they don't then:
     * 1) Create the index
     * 2) Set the default config to point to the appmetrics index
     * 
     * If there is, we don't want to change the default index
     */
    esearch.searchExists({
		index: '.kibana',
		type : 'config'
	}, function (err, res) {
		if (!res.exists === true) {
			putConfigs(esearch);
		}
	});
    
    /*
     * Check to see if there are any Kibana index format mappings for the index, if not:
     * 1) Set the index format mappings
     * 2) Upload default charts
     * 3) Upload default dashboards
     */
    esearch.searchExists({
		index: '.kibana',
		type : 'index-pattern',
		body: {
			query: {
				match: {
					_id: INDEX
				}
			}
		}
	}, function (err, res) {
		if (!res.exists === true) {
    		putIndexes(esearch);
    		putCharts(esearch);
    		putDashboards(esearch);
		}
	});
    
    var startMonitoring = function() {

    	/*
    	 * Memory is a special case as we change the structure of the data
    	 */
    	monitor.on('memory', function handleMem(memory) {
    		var data = {
    			'process':	{
    				'private':		memory.private,
    				'physical': 	memory.physical,
    				'virtual': 		memory.virtual,
    			},
    			'system' : {
    				'physical': 	memory.physical_used,
    				'total' : 		memory.physical_total
    			}			
    		};
    		publishData('memory', memory.time, data);
    	});
    	
    	var registerCallback = function(value) {
    		/*
    		 * Ignore memory as its a special case (see above)
    		 */
    		var preConfigured = ['memory'];
    		if (preConfigured.indexOf(value.type) === -1) { 
    			
    			monitor.on(value.type, function(eventdata) {
    				var data = {};
    				var properties = value.body.properties[value.type].properties;
    				for (var prop in properties) {
    					if (properties.hasOwnProperty(prop)) {
    						data[prop] = eventdata[prop];
    					}
    				}
    				publishData(value.type, eventdata.time, data);
    			});
    		}
    	};
    	
    	/*
    	 * Register a callback for every event type we have a mapping for
    	 */
    	var json = getJSONfromDir('mappings', registerCallback);
    	
    };
    
    var getJSONfromDir = function (directory, callback) {
    	var path = require('path');
		var fs = require('fs');
	
		var dirPath = path.join(__dirname, '..', directory); 
		fs.readdir(dirPath, function (err, files) {
			if (err) {
				console.log('Failed to read from ' + dirPath); 
			} else {
				files.forEach(function (fileName) {
					var file = path.join(dirPath, fileName);
					callback.call(this, JSON.parse(fs.readFileSync(file, 'utf8')));
				});
			}
		});
    };
    
    /*
     * Put the mappings for the data we create into the index. It
     * shouldn't matter if we replace existing records as they should be the same...
     */
    var putMappings = function (esearch, index) {  
    	getJSONfromDir('mappings', function (mapping) {
    		esearch.indices.putMapping(mapping, function (err, res) {
    			if (err) {
    				console.log('Failed to put mapping ' + err);
    			} else {
//					console.log('Put mapping for ' + fileName);
    			}
    		});
    	});
    };

    /*
     * Publishing data to ElasticSearch (ES)
     * This is done by writing data to a bulkarray, which is then bulk
     * updated to ES on an interval timer.
     */
    
    var bulkarray = [];
    
    var bulkUpdater = setInterval(function (){
    	if (bulkarray.length > 0) {
    		publishBulk(bulkarray);
    		bulkarray = [];
    	}
    }, 30000);
    
    var publishBulk = function(bulkarray) {
    	esearch.bulk({
    		index:	INDEX,
    		body:	bulkarray
    	}, function (err, rep) {
    		if (err) {
    			console.log('Error doing bulk update ' + err);
    		} else {
//    			console.log('Published bulk update ' + res);
    		}
    	});
    };
    
    var publishData = function(type, time, data) {
    	var entry = new Entry(type, time);
    	entry[String(type)] = data;
    	bulkarray.push(
    		{ index:  {_type: type } },
         	JSON.stringify(entry));
    };

	var putConfigs = function (esearch) {
		getJSONfromDir('configs', function (config) {
			config.body.defaultIndex = INDEX;
    		esearch.index(config, function (err, res) {
				if (err) {
					console.log('Failed to put config ' + err);
				} else {
//					console.log('Put config for ' + config);
				}
    		});
    	});	
	};

	var putIndexes = function (esearch) {
		getJSONfromDir('indexes', function (index) {
			index.id = INDEX;
			index.body.title = INDEX;
    		esearch.index(index, function (err, res) {
				if (err) {
					console.log('Failed to put index ' + err);
				} else {
//					console.log('Put index for ' + index);
				}
    		});
    	});	
	};

	var putDashboards = function (esearch) {
		getJSONfromDir('dashboards', function (dashboard) {
    		esearch.index(dashboard, function (err, res) {
				if (err) {
					console.log('Failed to put dashboard ' + err);
				} else {
//					console.log('Put dashboard for ' + dashboard);
				}
    		});
    	});	
	};

	var putCharts = function (esearch) {
		getJSONfromDir('charts', function (chart) {
			chart.body.kibanaSavedObjectMeta.searchSourceJSON = chart.body.kibanaSavedObjectMeta.searchSourceJSON.replace('appmetrics', INDEX);
    		esearch.index(chart, function (err, res) {
				if (err) {
					console.log('Failed to put chart ' + err);
				} else {
//					console.log('Put chart for ' + chart);
				}
    		});
    	});	
	};
	
	return monitor;
};

function Entry(type, time) {
    this.timestamp = new Date(time);
    this.hostName = HOSTNAME;
    this.pid = PID;
    this.applicationName = APPNAME;
    this[String(type)] = {};
}

exports.monitor = monitor;