/*	Provides the functionality of Python's itertools.product in JS.
	Code modified from gist.github.com/cybercase/db7dde901d7070c98c48 */

function product() {
	var args = Array.prototype.slice.call(arguments); // makes array from arguments
	return args.reduce(function tl (accumulator, value) {
		var tmp = [];
		accumulator.forEach(function (a0) {
			value.forEach(function (a1) {
				tmp.push(a0.concat(a1));
			});
		});
		return tmp;
	}, [[]]);
}

function repeatProduct(arr, count) {
	return product(...new Array(count).fill(arr));
}

// console.log(product([1], [2, 3], ['a', 'b']));
// console.log(repeatProduct([0, 1], 3));

module.exports = {
	product: product,
	repeatProduct : repeatProduct
};