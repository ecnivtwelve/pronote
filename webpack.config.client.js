var path = require('path')
module.exports = {
  ...require('cozy-konnector-build/webpack.config.clisk'),
  entry: './src/client.js',
  output: {
    path: path.join(process.cwd(), 'build'),
    filename: 'main.js'
  },
  module: {
    rules: [
      {
        test: /\.html$/i,
        use: 'raw-loader',
      },
    ],
  },
}
