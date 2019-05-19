'use strict';

const Homey = require('homey');

const COMMAND_QUEUE_RETRY = 10;
const BLE_DISCONNECT_TIMEOUT = 10;

const {
	SERVICE_UUID,
	SERVICE_CHARACTERISTIC_UUID
} = require('../../config');

class SubwooferDevice extends Homey.Device {

	onInit() {
		this.log('SVSound has been inited');
		this.setUnavailable();

		this.registerMultipleCapabilityListener([
			'preset',
			'volume_db'
		], this._onCapabilitySubwoofer.bind(this), 300);
		
		const {id} = this.getData();
		const driver = this.getDriver();

		this._connectionTimer = null;
		this._commandBusy = false;
		this._commandQueue = [];
		this._commandRetry = 0;

		driver.ready(() => {
			try {
				this._device = driver.getSubwoofer(id);
				this._onDeviceInit();
			} catch(err) {
				driver.once(`device:${id}`, device => {
					this._device = device;
					this._onDeviceInit();
				});
			}
		});
	}

	async _onDeviceInit() {
		this.setAvailable();
	}

	_connectionTimerStart(timeout) {
		this._connectionTimerStop();

		if (timeout > 0) {
			this._connectionTimer = setTimeout(() => {
				this._connectionTimer = null;
				this._disconnect();
			}, timeout * 1000);
		}
	}

	_connectionTimerStop() {
		if (this._connectionTimer) {
			clearTimeout(this._connectionTimer);
			this._connectionTimer = null;
		}
	}

	_delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	_CRC16(buffer)
	{
		let crc = 0x0;

		for (let index = 0; index < buffer.length; index++) {
			const byte = buffer[index];
			let code = (crc >>> 8) & 0xff;

			code ^= byte & 0xff;
			code ^= code >>> 4;
			crc = (crc << 8) & 0xffff;
			crc ^= code;
			code = (code << 5) & 0xffff;
			crc ^= code;
			code = (code << 7) & 0xffff;
			crc ^= code;
		}

		return ((crc & 0xFF) << 8) | ((crc >> 8) & 0xFF);
	}

	async _getService() {
		/* Already connected? */
		if (this._peripheral && this._peripheral.isConnected) {
			this.log('_getService already connected');
			this._connectionTimerStart(BLE_DISCONNECT_TIMEOUT);
			const BLEservice = await this._peripheral.getService(SERVICE_UUID);
			return Promise.resolve(BLEservice);
		}

		/* Already trying to connect */
		if (this._connectionTimer) {
			this.log('_getService connection already started');
			this._connectionTimerStart(BLE_DISCONNECT_TIMEOUT);
			return Promise.resolve(null);
		}

		/* Connecting */
		this.log('_getService connecting');
		this._connectionTimerStart(BLE_DISCONNECT_TIMEOUT);
		this._peripheral = await this._device.connect();

		await this._peripheral.discoverAllServicesAndCharacteristics();
		const BLEservice = await this._peripheral.getService(SERVICE_UUID);

		if (!BLEservice) {
			this.log('_getService missing service');
			return Promise.reject(new Error('missing_service'));
		}

		return Promise.resolve(BLEservice);
	}

	async _disconnect() {
		this.log('_disconnect');

		this._commandBusy = true;
		this._connectionTimerStop();

		if (this._peripheral && this._peripheral.isConnected) {
			this.log('_disconnect peripheral');
			await this._peripheral.disconnect().catch(() => null);
		}

		this._commandBusy = false;

		delete this._peripheral;

		// Check if Queue is empty
		setTimeout(() => { this._processQueue(true); }, 500);

		return Promise.resolve(true);
	}

	async _processQueue(retry) {
		this.log('_processQueue', this._commandRetry, this._commandQueue.length);

		if (retry)
			this._commandRetry++;

		if (this._commandRetry >= COMMAND_QUEUE_RETRY) {
			this.log('_processQueue retries exceeded');
			this._commandQueue = [];
			this._commandRetry = 0;
		}

		if (this._commandQueue.length == 0) {
			this.log('_processQueue empty');
			return Promise.resolve(true);
		}

		try {
			if (this._commandBusy) {
				this.log('_processQueue is busy');
				return Promise.resolve(true);
			}

			const service = await this._getService();

			if (!service) {
				this.log('_processQueue service missing');
				setTimeout(() => { this._processQueue(true); }, 500);
				return Promise.reject(new Error('missing_service'));
			}

			this._commandBusy = true;

			while (this._commandQueue.length > 0) {
				this._connectionTimerStart(BLE_DISCONNECT_TIMEOUT);
				const command = this._commandQueue.shift();

				this.log('_processQueue writing', command);

				await service.write(SERVICE_CHARACTERISTIC_UUID, command)
					.catch((error) => {
						this.log(error.message);
					});

				/* Wait between commands, if send to fast this gives weird behaviour.
				 * Ideally we should wait for a response, but the Homey API is limited.
				 */
				await this._delay(250);
			}

			this._commandRetry = 0;
			this._commandBusy = false;

			return Promise.resolve(true);
		} catch (error) {
			this.log(error.message);
			this._disconnect();

			return Promise.reject(error);
		}
	}

	async _api(cmd) {
		this.log('_api', cmd);

		const crc = this._CRC16(cmd);
		cmd = Buffer.concat([cmd, Buffer.from([ (crc >> 8) & 0xFF, crc & 0xFF ])]);

		this._commandQueue.push(cmd);
		await this._processQueue(false);

		return Promise.resolve(true);
	}

	async _onCapabilitySubwoofer(valueObj) {
		this.log('_onCapabilitySubwoofer', valueObj);

		if (typeof valueObj.preset === 'string') {
			this.getPresets().forEach((preset) => {
				if (preset.name === valueObj.preset)
					this.setPreset(preset);
			});
		} else if (typeof valueObj.volume_db === 'number') {
			this.setVolume(valueObj.volume_db);
		}
	}

	getPresets() {
		return [
			{ id: 0x18, name: 'Movie'},
			{ id: 0x19, name: 'Music'},
			{ id: 0x1a, name: 'Custom'},
			{ id: 0x1b, name: 'Default'}
		];
	}

	setPreset(preset) {
		this.setCapabilityValue('preset', preset.name);

		const cmd = Buffer.from([ 0xAA, 0x07, 0x04, 0x0F, 0x00, preset.id, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00 ]);
		return this._api(cmd);
	}

	setVolume(volume) {
		if (volume < -60 || volume > 0)
			return Promise.reject(new Error('Value out of bounds'));

		this.setCapabilityValue('volume_db', volume);

		const buf = Buffer.alloc(2);

		if (volume >= 0) {
			buf.writeUInt8(0x00, 0);
			buf.writeUInt8(0x00, 1);
		} else {
			const vb = (0xFFFF - (Math.abs(volume) * 0x0A)) + 1;
			console.log((vb & 0xFF));
			console.log(((vb >> 8) & 0xFF));

			buf.writeUInt8((vb & 0xFF), 0);
			buf.writeUInt8(((vb >> 8) & 0xFF), 1);
		}

		const cmd = Buffer.concat([Buffer.from([ 0xAA, 0xF0, 0x1F, 0x11, 0x00, 0x04, 0x00, 0x00, 0x00, 0x2C, 0x00, 0x02, 0x00 ]), buf]);
		return this._api(cmd);
	}

}

module.exports = SubwooferDevice;