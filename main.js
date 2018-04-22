/**
 *
 * gardena smart system adapter
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils

// for communication
var request = require('request');

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.gardena.0
var adapter = utils.adapter('gardena');

const mower_commands_arr = {
  'park_until_next_timer': {},
  'park_until_further_notice': {},
  'start_resume_schedule': {},
  'start_override_timer': {
    'duration': {
      'val': 1440,
      'type': 'number',
      'desc': 'Ignore timer.'
    }
  },
  'start_override_timer_duration': {}
};

var conn_timeout_id = null;

// triggered when the adapter is installed
adapter.on('install', function () {
  // create connection variable https://github.com/ioBroker/ioBroker/wiki/Adapter-Development-Documentation#infoconnection
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
  if(id && state && id === state.from.split('.')[2]+'.'+state.from.split('.')[3] + '.' + 'info.connection') {
    adapter.log.debug('Change in connection detected.');

    if(state.val === true) {
      // got connection
      clearTimeout(conn_timeout_id);
      poll(function() {});
      // enable polling
      setInterval(function () {
        poll(function() {});
      }, Number(adapter.config.gardena_polling_interval)*1000);
    } else {
      // lost connection
      connect();
      conn_timeout_id = setTimeout(function () {
        connect();
      }, Number(adapter.config.gardena_reconnect_interval)*1000);
    }
  }

  // you can use the ack flag to detect if it is status (true) or command (false)
  if (state && state.val && !state.ack) {
    adapter.log.debug('ack is not set!');

    triggeredEvent(id, state, function (err) {
      if(err) adapter.log.error('An error occurred during trigger!')
    });
  }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
  adapter.setObjectNotExists('info.connection', {
    type: 'state',
    common: {
      name: 'connected',
      desc: 'Connected to Gardena Smart System Service?',
      type: 'boolean',
      def: 'false',
      read: 'true',
      role: 'value.info',
      write: 'false'
    },
    native: {}
  });

  adapter.setObjectNotExists('info.token', {
    type: 'state',
    common: {
      name: 'token',
      desc: 'Token from Gardena Smart System Service?',
      type: 'string',
      read: 'true',
      write: 'false',
      role: 'value.info'
    },
    native: {}
  });

  adapter.setObjectNotExists('info.user_id', {
    type: 'state',
    common: {
      name: 'user_id',
      desc: 'Userid from Gardena Smart System Service?',
      type: 'string',
      read: 'true',
      write: 'false',
      role: 'value.info'
    },
    native: {}
  });

  adapter.setObjectNotExists('info.refresh_token', {
    type: 'state',
    common: {
      name: 'refresh_token',
      desc: 'Refresh token from Gardena Smart System Service?',
      type: 'string',
      read: 'true',
      write: 'false',
      role: 'value.info'
    },
    native: {}
  });

  // start main function
  main();
});

// main function
function main() {

  // The adapters config (in the instance object everything under the attribute "native") is accessible via
  // adapter.config:
  adapter.log.info('Starting gardena smart system adapter');

  // check setup
  //syncConfig();

  // connect to gardena smart system service
  connect();

  // gardena subscribes to all state changes
  adapter.subscribeStates('devices.*.commands.*.send');
  adapter.subscribeStates('info.connection');
}

// connect to gardena smart cloud service
function connect() {
  adapter.log.info("Connecting to Gardena Smart System Service ...");

  // get username and password from database
  var username = adapter.config.gardena_username;
  var password = adapter.config.gardena_password;

  var options_connect = {
    url: 'https://sg-api.dss.husqvarnagroup.net/sg-1/sessions',
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
      adapter.setState('info.token', '', true);
      adapter.setState('info.user_id', '', true);
      adapter.setState('info.refresh_token', '', true);
      adapter.setState('info.connection', false, true);

      adapter.log.error(err);
      adapter.log.info('Connection failure.');
    } else {
      // connection successful
      adapter.log.debug('Response: ' + response.statusMessage);

      // connection established but auth failure
      if(response.statusMessage === 'Unauthorized') {
        adapter.setState('info.token', '', true);
        adapter.setState('info.user_id', '', true);
        adapter.setState('info.refresh_token', '', true);
        adapter.setState('info.connection', false, true);

        adapter.log.debug('Delete auth tokens.');
        adapter.log.error('Connection works, but authorization failure (wrong password?)!');
      } else {
        // save tokens etc.
        adapter.setState('info.token', body.sessions.token, true);
        adapter.setState('info.user_id', body.sessions.user_id, true);
        adapter.setState('info.refresh_token', body.sessions.refresh_token, true);
        adapter.setState('info.connection', true, true);

        adapter.log.debug('Saved auth tokens.');
        adapter.log.info('Connection successful.');
      }
    }
  });
}

// poll locations, devices, etc.
function poll(callback) {

  adapter.log.info('Poll locations.');
  retrieveLocations(function (err) {
    if(err) {
      adapter.log.error('Error retrieving the locations.')
    } else {
      // get all devices and create iobroker tables
      adapter.log.debug('Retrieved all locations, get all devices');

      // get all devices and create iobroker tables
      retrieveAllDevices(function (err) {
        if(err) {
          adapter.log.error('An error occured during polling devices.');
        } else {
          adapter.log.info('Polling successful!');
        }
      });
    }
  });

  if(callback) callback(false);
}

// send a command to the gardena device
function sendCommand(cmd, deviceid, locationid, callback) {

  getConnectionInfo(function (err, token, user_id, refresh_token) {
    // setup the request
    //'gardena.' + adapter.instance + '.devices.' + deviceid + '.commands.' + cmd

    var json2send = {
      "name": cmd,
      "parameters": {}
    };

    adapter.getForeignStates(adapter.namespace + '.devices.' + deviceid + '.commands.' + cmd + '.*', function (err, objs) {
      for(var cobj in objs) {
        // ignore send state object
        if(cobj.split('.')[cobj.split('.').length-1] !== 'send') {
          var param = cobj.split('.')[cobj.split('.').length-1];

          json2send['parameters'][param] = objs[cobj].val;
        }
      }

      // send the request
      var options = {
        url: 'https://sg-api.dss.husqvarnagroup.net/sg-1/devices/' + deviceid + '/abilities/mower/command?locationId=' + locationid,
        headers: {
          "Content-Type": "application/json",
          "X-Session": token
        },
        method: "POST",
        json: json2send
      };

      request(options, function (err, response, jsondata) {
        if (err) {
          adapter.log.error('Could not send command.');
          adapter.setState('info.connection', false, true);
        } else {
          adapter.log.info('Command send.');
        }
      });
    });

  callback(false);
  });
}

// an event was triggered
function triggeredEvent(id, state, callback) {

  var deviceid = id.split('.')[3];
  var cmd = id.split('.')[5];

  // ok, we have the device id, get the location id
  adapter.getState('devices.' + deviceid + '.locationid', function(err, state) {
    if(err) adapter.log.error('Could not get location ID for device ' + deviceid);

    if(state) {
      var locationid = state.val;
      sendCommand(cmd, deviceid, locationid, function(err) {
        if(err) adapter.log.error('Could not send command ' + command + ' for device id ' + deviceid);
      });
    }
  });

  callback(false);
}

// retrieve locally saved connection params
function getConnectionInfo(callback) {
  adapter.getState('info.connection', function (err, state) {
    if (err) adapter.log.error(err.message);

    if (state.val === true) {
      adapter.getState('info.token', function (err, state) {
        if (err) adapter.log.error(err.message);
        var token = state.val;

        adapter.getState('info.user_id', function (err, state) {
          if (err) adapter.log.error(err.message);
          var user_id = state.val;

          adapter.getState('info.refresh_token', function (err, state) {
            if (err) adapter.log.error(err.message);
            var refresh_token = state.val;

            callback(false, token, user_id, refresh_token);
          });
        });
      });
    }
  });
}

// retrieve locations
function retrieveLocations(callback) {
  getConnectionInfo(function (err, token, user_id, refresh_token) {
    // setup the request
    var options = {
      url: 'https://sg-api.dss.husqvarnagroup.net/sg-1/locations/?user_id=' + user_id,
      headers: {
        "Content-Type": "application/json",
        "X-Session": token
      },
      method: "GET",
      json: true
    };

    request(options, function (err, response, jsondata) {
      if (err) {
        adapter.setState('info.connection', false, true);
        adapter.log.error('Could not retrieve locations.');
      } else {
        adapter.log.info('Update DB locations.');
        updateDBLocations(jsondata, callback);
      }
    });
  });
}

// update locations in database
function updateDBLocations(jsondata, callback) {
  adapter.createDevice('locations', {
    name: 'locations'
  });

  // update locations in the database
  for(var ckey in jsondata) {
    if (jsondata.hasOwnProperty(ckey) && ckey === 'locations') {
      var locations = jsondata[ckey];

      // go through all locations
      for(var i=0;i<locations.length;i++) {
        var curlocation = locations[i];

        // retrieve location id
        var locid = curlocation['id'];

        if(locid) {
          // maybe it is a valid location id?
          adapter.createChannel('locations', locid, {
            name: locid,
            role: 'gardena.location'
          });

          // go through all properties in locations
          for(var lkey in curlocation) {
            if (curlocation.hasOwnProperty(lkey)) {
              switch(lkey) {
                case 'name':
                  adapter.createState('locations', locid, lkey, {
                    name: lkey,
                    role: 'gardena.name',
                    read: true,
                    write: false,
                    def: curlocation[lkey]
                  });
                  break;
                case 'devices':
                  // save the devices as comma delimited string
                  adapter.createState('locations', locid, 'devices', {
                    name: 'devices',
                    def: curlocation[lkey].toString(),
                    write: false,
                    read: true,
                    role: 'gardena.devices'
                  }, true);
                  break;
                case 'geo_position':
                // go through geoposition
                  for(var cgeo in curlocation[lkey]) {

                    adapter.createState('locations', locid, 'geo_position.' + cgeo, {
                      name: 'geo_position.' + cgeo,
                      def: curlocation[lkey][cgeo],
                      write: false,
                      read: true,
                      role: 'gardena.geo_position'
                    }, true);
                  }
                  break;
              }
            }
          }
        } else {
          adapter.log.error('Invalid location id!');
        }
      }
    }
  }

  callback(false);
}

// get device data for all locations
function retrieveAllDevices(callback) {

  getConnectionInfo(function (err, token, user_id, refresh_token) {

    // go through all location ids and retrieve device information
    adapter.getChannelsOf('locations', function (err, channels) {

      for (var i=0;i<channels.length;i++) {
        var location_id = channels[0].common.name;
        retrieveDevicesFromLocation(token, location_id, function (err) {
          if (err) {
            adapter.log.error('Could not get device from location ' + location_id);
          }

          callback(false);
        });
      }
    });
  });
}

// get device device data for a location
function retrieveDevicesFromLocation(token, location_id, callback) {

  // setup request
  var options = {
    url: 'https://sg-api.dss.husqvarnagroup.net/sg-1/devices?locationId=' + location_id,
    headers: {
      "Content-Type": "application/json",
      "X-Session": token
    },
    method: "GET",
    json: true
  };

  request(options, function (err, response, jsondata) {
    if (err) {
      adapter.setState('info.connection', false, true);
      adapter.log.debug('Could not retrieve devices.');
    } else {
      adapter.log.info('Retrieve device data.');
      updateDBDevices(location_id, jsondata, callback);
    }
  });
}

// update database devices
function updateDBDevices(location_id, jsondata, callback) {
  // go through all devices
  for(var i=0;i<jsondata.devices.length;i++) {
    var cdev = jsondata.devices[i];

    if(cdev.id) {
      // there seems to be a valid device id
      adapter.setObject('devices.' + cdev.id, {
        type: "device",
        common: {
          name: cdev.category + '_' + cdev.name,
          role: "device"
        },
        native: {}
      });

      JSONtoDB(cdev, 'devices.' + cdev.id);

      // save location id (redundant, but simpler)
      setStateEx('devices.' + cdev.id + '.locationid', {
          common: {
            name: "locationid",
            role: "gardena.locationid",
            write: false,
            read: true,
            type: "string"
          }
        }, location_id, true);

      // set commands
      // get category
      adapter.getState('devices.' + cdev.id + '.category', function (err, state) {
        if(state) {
          switch(state.val) {
            case 'mower':
              // create command states

              // first iterate over the commands
              for (var curcmd in mower_commands_arr) {
                if (!mower_commands_arr.hasOwnProperty(curcmd)) continue;

                // create activator state
                setStateEx('devices.' + cdev.id + '.commands.' + curcmd + '.send', {
                  common: {
                    name: 'send',
                    role: 'gardena.command_trigger',
                    desc: 'Send command.',
                    write: true,
                    read: true,
                    type: "boolean"
                  }
                }, false, true);

                // then iterate over the parameters
                for (var cparam in mower_commands_arr[curcmd]) {

                  // create parameter
                  setStateEx('devices.' + cdev.id + '.commands.' + curcmd + '.' + cparam, {
                    common: {
                      name: cparam,
                      role: 'gardena.command_parameter',
                      desc: mower_commands_arr[curcmd][cparam].desc,
                      write: true,
                      read: true,
                      type: mower_commands_arr[curcmd][cparam].type
                    }
                  }, mower_commands_arr[curcmd][cparam].val, true);

                }
              }
            break;
          }
        }
      });

    } else {
      adapter.log.error('Invalid device id!');
    }
  }
  callback(false);
}

// synchronize config
function syncConfig() {

}

// write JSON object into DB
function JSONtoDB(json, root_id) {

  for (var citem in json) {
    if (!json.hasOwnProperty(citem)) continue;

    if (Array.isArray(json[citem])) {
      for (var i = 0; i < json[citem].length; i++) {
        var curelem = json[citem][i];

        // check if curelem is an object
        if(typeof curelem === 'object') {
          JSONtoDB(curelem, root_id + '.' + citem + '.' + i);
        } else {
          var d = {};
          d[i] = curelem;
          JSONtoDB(d, root_id + '.' + citem);
        }
      }
    } else if (typeof json[citem] === 'object') {
      JSONtoDB(json[citem], root_id + '.' + citem);
    } else if (typeof json[citem] === 'string') {
      setStateEx(root_id + '.' + citem, {
        common: {
          name: citem,
          write: false,
          read: true,
          type: "string",
          role: "gardena.string"
        }
      }, json[citem], true);
    } else if (typeof json[citem] === 'boolean') {
      setStateEx(root_id + '.' + citem, {
        common: {
          name: citem,
          write: false,
          read: true,
          def: false,
          type: "boolean",
          role: "gardena.boolean"
        }
      }, json[citem], true);
    } else if (typeof json[citem] === 'number') {
      setStateEx(root_id + '.' + citem, {
        common: {
          name: citem,
          write: false,
          read: true,
          type: "number",
          role: "gardena.number"
        }
      }, json[citem], true);
    }
  }
}

// setStateEx
function setStateEx(id, common, val, ack, callback) {
  var a = {
    type: 'state',
    native: {}
  };

  var common_full = Object.assign({}, a, common);

  var cfunc = function (err) {
    adapter.setState(id, val, ack, function(err) {
      if(err) adapter.log.error('Could not create extende state id:' + id + ', val:' + val);
    });
  };

  adapter.setObject(id, common_full, cfunc);

  if(callback) callback(false);
}
