/* Seedable version of the array-shuffler from underscore.js */
const Random = require("random-js");

function shuffleSeed(arr, seed) {
	const mt = Random.engines.mt19937().seed(seed);
	const length = arr.length;
	const shuffled = Array(length);

	for(let index = 0; index < length; index++) {
		const rand = Random.integer(0, index)(mt);

		if (rand !== index)
			shuffled[index] = shuffled[rand];

		shuffled[rand] = arr[index];
	}

	return shuffled;
}

module.exports = shuffleSeed;