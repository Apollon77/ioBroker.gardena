/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
const utils =    require(__dirname + '/lib/utils'); // Get common adapter utils

// for communication
const request = require('request');

const deepmerge = require('deepmerge');

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.gardena.0
const adapter = utils.Adapter('gardena');

// gardena commands
const gardena_commands = require(__dirname + '/gardena_commands.json');
const min_polling_interval = 60; // minimum polling interval in seconds

// gardena config
const gardena_config = {
  "baseURI": "https://sg-api.dss.husqvarnagroup.net",
  "devicesURI": "/sg-1/devices",
  "sessionsURI": "/sg-1/sessions",
  "locationsURI": "/sg-1/locations",
  "abilitiesURI": "/abilities"
};

// auth data (tokens etc.)
let auth = {
  "token": null,
  "user_id": null,
  "refresh_token": null
};

let conn_timeout_id = null; // timeout interval id
let update_locations_counter = 30; // update locations in the database with this interval (saves resources)

const gardenaDBConnector = require(__dirname + '/lib/gardenaDBConnector');

// triggered when the adapter is installed
adapter.on('install', function () {
});

// is called when the adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
  try {
    adapter.log.info('cleaned everything up...');
      callback();
  } catch (e) {
      callback();
  }
});

// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
  // Warning, obj can be null if it was deleted
  adapter.log.debug('objectChange ' + id + ' ' + JSON.stringify(obj));
});

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
  // Warning, state can be null if it was deleted
  adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

  // connection related state change
  if(id && state && id === state.from.split('.')[2] + '.' + state.from.split('.')[3] + '.' + 'info.connection') {
    adapter.log.debug('Change in connection detected.');

      if (Number(adapter.config.gardena_polling_interval)*1000 < min_polling_interval) {
        adapter.log.error('Polling interval should be greater than ' + min_polling_interval);
      } else {
        if (state.val === true) {
          // got connection
          clearTimeout(conn_timeout_id);
          poll();

          // enable polling
          setInterval(function () {poll();}, Number(adapter.config.gardena_polling_interval) * 1000);
        } else {
          // lost connection
          connect(function(err, auth_data) {
            if(!err) {
              auth = auth_data;
            } else {
              adapter.log.error(err);
            }
          });

          conn_timeout_id = setTimeout(function () {
            connect(function(err, auth_data) {
              if(!err) {
                auth = auth_data;
              } else {
                adapter.log.error(err);
              }
            });
          }, Number(adapter.config.gardena_reconnect_interval) * 1000);
        }
      }
  }

  // you can use the ack flag to detect if it is status (true) or command (false)
  if (state && state.val && !state.ack) {

    /*
    triggeredEvent(id, state, function (err) {
      if(err) adapter.log.error('An error occurred during trigger!')
    });
    */
  }
});

// is called when databases are connected and adapter received configuration.
adapter.on('ready', function () {
  // start main function
  main();
});

// messages
adapter.on('message', function (obj) {
  let wait = false;
  let credentials;
  let msg;

  if (obj) {
    switch (obj.command) {
      case 'checkConnection':
        credentials = JSON.parse(obj.message);

        connect(credentials.gardena_username, credentials.gardena_password, function (err) {
          if (!err) {
            adapter.sendTo(obj.from, obj.command, true, obj.callback);
          } else {
            adapter.sendTo(obj.from, obj.command, false, obj.callback);
          }
        });
        wait = true;
        break;
      case 'connect':
        credentials = obj.message;

        // check if already connected (do not care about the credentials)
        if(!auth.token) {
          connect(credentials.gardena_username, credentials.gardena_password, function (err, auth_data) {
            if (!err) {
              adapter.sendTo(obj.from, obj.command, auth_data, obj.callback);
            } else {
              adapter.sendTo(obj.from, obj.command, false, obj.callback);
            }
          });
        } else {
          adapter.sendTo(obj.from, obj.command, auth, obj.callback);
        }
        wait = true;
        break;
      case 'retrieveLocations':
        msg = obj.message;

        retrieveLocations(msg.token, msg.user_id, function (err, locations) {
          if(!err) {
            adapter.sendTo(obj.from, obj.command, locations, obj.callback);
          } else {
            adapter.sendTo(obj.from, obj.command, false, obj.callback);
          }
        });
        wait = true;
        break;
      case 'retrieveDevices':
        msg = obj.message;

        retrieveDevicesFromLocation(msg.token, msg.location_id, function (err, devices) {
          if(!err) {
            adapter.sendTo(obj.from, obj.command, devices, obj.callback);
          } else {
            adapter.sendTo(obj.from, obj.command, false, obj.callback);
          }
        });
        wait = true;
        break;
      default:
        adapter.log.warn("Unknown command: " + obj.command);
        break;
    }
  }
  if (!wait && obj.callback) {
    adapter.sendTo(obj.from, obj.command, obj.message, obj.callback);
  }

  return true;
});

// main function
function main() {
  adapter.log.info('Starting gardena smart system adapter');

  gardenaDBConnector.setAdapter(adapter);  // set adapter instance in the DBConnector

  syncConfig();  // sync database with config

  // connect to gardena smart system service and start polling
  connect(function(err, auth_data) {
    if(!err) {
      auth = auth_data;
    } else {
      adapter.log.error(err);
    }
  });

  // TODO: some datapoints have to be subscribed (those ones with writable set to true)
  // gardena subscribes to all state changes
  adapter.subscribeStates('devices.*.commands.*.send');
  adapter.subscribeStates('info.connection');
}

// connect to gardena smart cloud service
function connect(username, password, callback) {
  adapter.log.info("Connecting to Gardena Smart System Service ...");

  if(!username || typeof username === 'function') {
    username = adapter.config.gardena_username;
  }

  if(!password || typeof password === 'function') {
    password = adapter.config.gardena_password;
  }

  let options_connect = {
    url: gardena_config.baseURI + gardena_config.sessionsURI,
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST",
    json: {
      "sessions": {
        "email": username,
        "password": password
      }
    }
  };

  request(options_connect, function(err, response, body){
    if(err || !response) {
      // no connection or auth failure
      adapter.log.error(err);
      adapter.log.info('Connection failure.');
      adapter.setState('info.connection', false);

      auth = {
        user_id: null,
        token: null,
        refresh_token: null
      };

      if(callback) callback(err, auth);
    } else {
      // connection successful
      adapter.log.debug('Response: ' + response.statusMessage);

      // connection established but auth failure
      if(response.statusMessage === 'Unauthorized') {
        auth = {
          user_id: null,
          token: null,
          refresh_token: null
        };

        adapter.setState('info.connection', false);
        adapter.log.debug('Deleted auth tokens.');
        adapter.log.error('Connection works, but authorization failure (wrong password?)!');
        if(callback) callback(err, auth);
      } else {
        // save tokens etc.
        if(body && body.hasOwnProperty('sessions')
          && body.sessions.hasOwnProperty('user_id')
          && body.sessions.hasOwnProperty('token')
          && body.sessions.hasOwnProperty('refresh_token')) {

          auth = {
            user_id: body.sessions.user_id,
            token: body.sessions.token,
            refresh_token: body.sessions.refresh_token
          };

          adapter.setState('info.connection', true);
          adapter.log.debug('Saved auth tokens.');
          if (callback) callback(false, auth);
        } else {
          adapter.log.debug('No auth data received');
          adapter.setState('info.connection', false);
          if (callback) callback('No auth data received');
        }
      }
    }
  });
}

// poll locations, devices, etc.
function poll(callback) {
  // first poll the locations (if the counter says we should do so)
  if(update_locations_counter === 30) {
    adapter.log.info('Polling locations.');
    retrieveLocations(auth.token, auth.user_id, function (err, locations) {
      if (err || !locations) {
        adapter.log.error('Error retrieving the locations.')
      } else {
        gardenaDBConnector.updateDBLocations(locations);
        adapter.log.info('Updated locations in the database.');
      }
      adapter.log.debug('Retrieved all locations.');
      update_locations_counter = 0;
    });
  }
  update_locations_counter += 1;

  // poll datapoints for devices for all locations
  adapter.getStates('gardena.' + adapter.instance + '.locations.*', function (err, states) {
    if(err) {
      adapter.log.error(err);
      return
    }
    // get distinct locations
    let locations = [];
    for(let cloc in states) {
      if(!locations.includes(cloc.split('.')[3])) {
        locations.push(cloc.split('.')[3]);
      }
    }

    // get devices for all locations
    for(let i=0;i<locations.length;i++) {
      retrieveDevicesFromLocation(auth.token, locations[i], function (err, devices) {
        if (err) {
          adapter.log.error('Could not get device from location.');
          if (callback) callback(err);
        } else {
          gardenaDBConnector.updateDBDatapoints(locations[i], devices, function (err) {
            if (callback) callback(err);
          });
        }
      });
    }
  });
}

// create json that we have to send to the device
function getJSONToSend(id, cmd, deviceid, callback) {

  function getCmdNamespace(id) {
    let cmd_namespace = '';
    for(let i=0;i<id.split('.').length - 1;i++) {
      cmd_namespace += id.split('.')[i];
      if(i < (id.split('.').length - 2)) cmd_namespace += '.';
    }
    return cmd_namespace;
  }

  function getDeviceNamespace(id, deviceid) {
    let dev_namespace = '';
    let dev_id;

    for(let i=0;i<id.split('.').length;i++) {
      if(id.split('.')[i] === deviceid) {
        dev_id = i;
        break;
      }
    }

    for(let i=0;i<dev_id+1;i++) {
      dev_namespace += id.split('.')[i];
      if(i < dev_id) dev_namespace += '.';
    }
    return dev_namespace;
  }

  function removeNamespace(id) {
    let rest = '';
    // remove namespace
    for(let i = 5;i< id.split('.').length; i++) {
      rest += id.split('.')[i];
      if (i < id.split('.').length - 1) rest += '.';
    }
    return rest;
  }

  function removeFirstElement(id) {
    let rest = '';
    for (let i = 1; i < id.split('.').length; i++) {
      rest += id.split('.')[i];
      if (i < id.split('.').length - 1) rest += '.';
    }

    return rest;
  }

  function removeLastElement(id) {
    let rest = '';
    for(let i=0;i<id.split('.').length - 1;i++) {
      rest += id.split('.')[i];
      if (i < id.split('.').length - 2) rest += '.';
    }

    return rest;
  }

  function paramToDict(id, cobj) {
    // get first element of the id

    if (id.split('.').length === 1) {
      let dict = {};
      dict[id] = cobj.val;
      return dict;
    } else {
      let dict = {};

      dict[id.split('.')[0]] = paramToDict(removeFirstElement(id), cobj);
      return dict;
    }
  }

  let cmd_namespace = getCmdNamespace(id);
  let dev_namespace = removeNamespace(id);

  // get values for parameters from the database
  adapter.getForeignStates(cmd_namespace + '.*', function (err, objs) {
    let json2send = {};
    let rest;

    // add modified activator state to objs, so that paramToDict works
    let dict = {};
    dict[removeLastElement(id) + '.name'] = {"val": cmd};
    objs = Object.assign({}, objs, dict);

    // first find the activator state
    for(let cobj in objs) {
      if(cobj.split('.')[cobj.split('.').length - 1] !== 'send') {
        // no activator state
        rest = removeFirstElement(removeNamespace(cobj, cmd_namespace));

        // merge parameters into json2send
        let jo = paramToDict(rest, objs[cobj]);
        json2send = deepmerge(json2send, jo);
      }
    }

    callback(json2send);
  });
}

function getRequestOptionsToSend(id, cmd, deviceid, locationid, callback) {
  // get category of the gardena device
  adapter.getState(adapter.namespace + '.devices.' + deviceid + '.category', function(err, category) {
    if (err || !category) {
      callback(err);
    } else {
      getJSONToSend(id, cmd, deviceid, function (json2send) {
        // get URI
        let g_cmds = gardena_commands[category.val];

        if(!g_cmds.hasOwnProperty('request') || !g_cmds.request == Object) {
          adapter.log.error('Missing request in gardena_commands.json');
          return
        }
        if(!g_cmds.request.hasOwnProperty('uri') || !g_cmds.request.uri) {
          adapter.log.error('Missing "uri" in request in gardena_commands.json');
          return
        }
        if(!g_cmds.request.hasOwnProperty('method') || !g_cmds.request.method) {
          adapter.log.error('Missing "method" in request in gardena_commands.json');
          return
        }

        let uri = gardena_config.baseURI + g_cmds.request.uri.replace('[deviceID]', deviceid).replace('[locationID]', locationid).replace('[cmd]', cmd);
        let method = g_cmds.request.method;

        let options = {
          url: uri,
          headers: {
            "Content-Type": "application/json",
            "X-Session": auth.token
          },
          method: method,
          json: json2send
        };

        callback(options);

      });
    }
  });
}

// send a command to the gardena device
function sendCommand(id, cmd, deviceid, locationid, callback) {

  getRequestOptionsToSend(id, cmd, deviceid, locationid, function(options) {
    let a = options;

    request(options, function (err, response, jsondata) {
      if (err) {
        adapter.log.error('Could not send command.');
        adapter.setState('info.connection', false);

        callback(err);
      } else {
        adapter.log.info('Command send.');

        // reset command switch to false
        adapter.setState('devices.' + deviceid + '.commands.' + cmd + '.send', false, false);
        callback(false);
      }
    });
  });
}

// an event was triggered
function triggeredEvent(id, state, callback) {

  let deviceid = id.split('.')[3];
  let cmd = id.split('.')[id.split('.').length - 2];

  // ok, we have the device id, get the location id
  adapter.getState('devices.' + deviceid + '.locationid', function(err, state) {
    if(err) {
      adapter.log.error('Could not get location ID for device ' + deviceid);

      callback(err);
    } else {
      if(state) {
        let locationid = state.val;
        sendCommand(id, cmd, deviceid, locationid, function(err) {
          if(err) {
            adapter.log.error('Could not send command ' + command + ' for device id ' + deviceid);
            callback(true);
          } else {
            callback(false);
          }
        });
      } else {
        callback(false);
      }
    }
  });
}

// retrieve locations
function retrieveLocations(token, user_id, callback) {
  // setup the request
  let options = {
    url: gardena_config.baseURI + gardena_config.locationsURI + '/?user_id=' + user_id,
    headers: {
      "Content-Type": "application/json",
      "X-Session": token
    },
    method: "GET",
    json: true
  };

  request(options, function (err, response, jsondata) {
    if (err) {
      adapter.setState('info.connection', false);
      adapter.log.error('Could not retrieve locations.');

      callback(err);
    } else {
      callback(false, jsondata);
    }
  });
}

// get device device data for a location
function retrieveDevicesFromLocation(token, location_id, callback) {

  // setup request
  let options = {
    url: gardena_config.baseURI + gardena_config.devicesURI + '/?locationId=' + location_id,
    headers: {
      "Content-Type": "application/json",
      "X-Session": token
    },
    method: "GET",
    json: true
  };

  request(options, function (err, response, jsondata) {
    if (err) {
      adapter.setState('info.connection', false);
      adapter.log.debug('Could not retrieve devices.');
      callback(err);
    } else {
      adapter.log.info('Retrieved device data.');
      callback(err, jsondata);
    }
  });
}

function setCommands_to_DB(cdev, prefix, cmd, callback) {

  // check type of command
  // 1. a property or parameter?
  // 2. activator state
  function getCmdType(cmd) {
    if (cmd.hasOwnProperty('name') && cmd.name && cmd.hasOwnProperty('type') && cmd.type && cmd.hasOwnProperty('val') && cmd.val) return 1;
    if (cmd.hasOwnProperty('cmd_desc') && cmd.cmd_desc) return 2;

    return -1;
  }

  // go through all commands
  for (let i=0;i<cmd.length;i++) {
    switch (getCmdType(cmd[i])) {
      case 1:
        // oh, we have a property or parameter here
        // create parameter
        let desc = ((cmd[i].hasOwnProperty('desc') && cmd[i].desc) ? cmd[i].desc : 'description');

        setStateEx(prefix + '.' + cmd[i].name, {
          common: {
            name: cmd[i].name,
            role: 'gardena.command_parameter',
            desc: desc,
            write: true,
            read: true,
            type: cmd[i].type
          }
        }, cmd[i].val, true);

        break;
      case 2:
        // create activator state
        setStateEx(prefix + '.' + cmd[i].cmd_desc + '.send', {
          common: {
            name: 'send ' + cmd[i].cmd_desc,
            role: 'gardena.command_trigger',
            desc: 'Send command ' + cmd[i].cmd_desc + '.',
            write: true,
            read: true,
            def: false,
            type: "boolean"
          }
        }, false, true);
        break;
    }

    // are there any other keys than "cmd_desc" or type that contain arrays?
    for (let citem in cmd[i]) {
      if (Array.isArray(cmd[i][citem]) && cmd[i][citem].length > 0) {
        if(cmd[i].hasOwnProperty('cmd_desc') && cmd[i].cmd_desc) {
          setCommands_to_DB(cdev, prefix + '.' + cmd[i].cmd_desc + '.' + citem, cmd[i][citem], callback)
        } else {
          setCommands_to_DB(cdev, prefix + '.' + citem, cmd[i][citem], callback)
        }
      }
    }
  }
}

// create set commands for device id (if not yet done)
function createSetCommands(cdev, callback) {
  // is there a category present?
  if(!cdev.hasOwnProperty('category') || !cdev.category) {
    callback(false);
    return;
  }

  // is category known by gardena_commands.json?
  let g_cmds = gardena_commands;
  if(!g_cmds.hasOwnProperty(cdev.category) || !g_cmds[cdev.category]) {
    callback(false);
    return;
  }

  // are there any commands?
  if(!g_cmds[cdev.category].hasOwnProperty('commands') || !g_cmds[cdev.category].commands) {
    callback(false);
    return;
  }

  if(!Array.isArray(g_cmds[cdev.category].commands) || !(g_cmds[cdev.category].commands.length > 0)) {
    callback(false);
    return;
  }

  // go recursively through commands array
  setCommands_to_DB(cdev, 'devices.' + cdev.id + '.commands', g_cmds[cdev.category].commands, function (err) {
    if(err) {
      callback(err);
    } else {
      callback(false);
    }
  });
}

// synchronize config
function syncConfig() {

  // compare gardena datapoints with objects, anything changed?
  // create locations inside the datapoints structure
  gardenaDBConnector.createDBDatapoints();

  /*
  function stateInConfig(cstate) {
    let states = adapter.config.gardena_datapoints;
    for(let j=0;j<states.length;j++) {
      if('gardena.' + adapter.instance + '.datapoints.' + states[j].name === cstate) {
        return true;
      }
    }
    return false;
  }

  function stateInDB(cstate, callback) {
    adapter.getStates('gardena.' + adapter.instance + '.datapoints.*', function(err, states) {
      callback(states.hasOwnProperty(cstate));
    });
  }


  let obj;
  let created_locations = [];
  for(let cdp in settings_dp) {
    if(!created_locations.includes(cdp.split('_')[0])) {
      // we have to create the location
      obj = {
        "_id": 'datapoints.' + cdp.split('_')[0],
        "type": "group",
        "common": {
          "name": settings_dp[cdp].location,
          "desc": "Location from Gardena Cloud."
        },
        "native": {}
      };
      adapter.setObjectNotExists('datapoints.' + cdp.split('_')[0], obj);
      created_locations.push(cdp.split('_')[0]);
    }
  }

  // create devices inside the datapoint structure
  let common;
  let created_devices = [];
  for(let cdp in settings_dp) {
    if(!created_devices.includes(cdp.split('_')[1])) {
      // we have to create the location
      common = {
        "common": {
          "name": settings_dp[cdp].device['name'],
          "desc": "Location from Gardena Cloud."
        }
      };
      adapter.createDevice('datapoints.' + cdp.split('_')[0] + '.' + cdp.split('_')[1], common);
      created_devices.push(cdp.split('_')[1]);
    }
  }

  // check if there are states that have to be removed
  adapter.getStates('gardena.' + adapter.instance + '.datapoints.*', function(err, states) {
    if (err) {
      adapter.log.error('SyncConfig: Could not retrieve states!');
    } else {
      for (let cstate in states) {
        if (!stateInConfig(cstate)) adapter.delObject(cstate);
      }
    }
  });

  // create missing states
  for(let cdp in settings_dp) {
    stateInDB('gardena.' + adapter.instance + '.datapoints.' + cdp.replace(/_/g, '.'), function(inDB) {
      if(!inDB) {
        // create states if they do not exis
        let common = {
          name: settings_dp[cdp].name,
          type: settings_dp[cdp].type,
          read: true
        };

        if(settings_dp[cdp].hasOwnProperty('role')) {
          common = Object.assign({}, common, {role: settings_dp[cdp].role})
        }

        if(settings_dp[cdp].hasOwnProperty('desc')) {
          common = Object.assign({}, common, {desc: settings_dp[cdp].desc})
        }

        if(settings_dp[cdp].hasOwnProperty('writeable')) {
          common = Object.assign({}, common, {writeable: settings_dp[cdp].writeable})
        }

        if(adapter.config.gardena_smart_datapoints) {
          adapter.createState(cdp.split('_')[1], undefined, common.name, common);
        } else {

        }

      }
    });
  }
  */
}
