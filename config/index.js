'use strict';

const uuids = {
	SERVICE_UUID: '1FEE6ACF-A826-4E37-9635-4D8A01642C5D',
	SERVICE_CHARACTERISTIC_UUID: '6409D79D-CD28-479C-A639-92F9E1948B43'
}

// convert uuids to homey uuids
for( let key in uuids ) {
	uuids[key] = uuids[key].toLowerCase().replace(/-/g, '');
}

module.exports = uuids;