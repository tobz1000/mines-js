module.exports = {
	mode: 'development',
	entry: [
		'babel-polyfill',
		'./src/public-src/game-grid.js'
	],
	output: {
		filename: 'bundle.js',
	},
	module: {
		rules: [{
			test: /\.js$/,
			exclude: /(node_modules|bower_components)/,
			use: {
				loader: 'babel-loader',
				options: {
					presets: ['env', 'react']
				}
			}
		}, {
			test: /\.css$/,
			use: {
				loader: 'style-loader!css-loader'
			}
		}]
	},
	devtool: "cheap-module-eval-source-map"
};
