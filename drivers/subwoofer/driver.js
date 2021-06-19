'use strict';

const Homey = require('homey');
const {
	SERVICE_UUID
} = require('../../config');

class SubwooferDriver extends Homey.Driver {

	onInit() {
		this.log('SVSound has been inited');
		
		this._devices = {};
		this.discover();
		
		// new Homey.FlowCardAction('set_preset')
		// 	.register()
		// 	.registerRunListener(({ device, preset }) => {
		// 		return device.setPreset(preset);
		// 	})
		// 	.getArgument('preset')
		// 	.registerAutocompleteListener(async (query, { device }) => {
		// 		const presets = await device.getPresets();
		// 		return presets.filter(preset => {
		// 			return preset.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
		// 		});
		// 	});

		this.homey.flow.getActionCard('set_volume')
			.registerRunListener(({ device, db }) => {
				return device.setVolume(db);
			})
			.getArgument('db');
	}

	discover() {
		this.homey.ble.discover([ SERVICE_UUID ], 1000)
			.then(devices => {
				devices.forEach(device => {
					if( this._devices[device.id] ) return;
					this.log(`Found device: ${device.id}`);
					this._devices[device.id] = device;
					this.emit(`device:${device.id}`, device);
				})
			})
			.catch(this.error);
	}

	async onPairListDevices( data ) {
		return await Promise.all(Object.keys(this._devices).map(deviceId => {
			return {
				name: this._devices[deviceId].localName,
				data: {
					id: deviceId,
				}
			}
		}));
	}

	getSubwoofer(id) {
		if(!this._devices[id])
			throw new Error('invalid_device');

		return this._devices[id];
	}

}

module.exports = SubwooferDriver;