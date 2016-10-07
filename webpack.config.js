module.exports = {
	entry: [
		'babel-polyfill',
		'./src/public-src/client.js'
	],
	output: {
		path: 'dist',
		filename: 'bundle.js',
	},
	module: {
		loaders: [
			{
				test: /\.js$/,
				exclude: /(node_modules|bower_components)/,
				loader: 'babel',
				query: {
					presets: ['react', 'latest']
				}
			},
			{
				test: /\.css$/,
				loader: 'style-loader!css-loader'
			},
		]
	},
	devtool: "cheap-module-eval-source-map"
};
