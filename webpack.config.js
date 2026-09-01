const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');
const webpack = require('webpack');
const path = require('path');

module.exports = {
    entry: './webextension/background.js',
    resolve: {
        fallback: {
            "fs": false,
        },
    },
    output: {
        path: path.resolve(__dirname, 'webextension'),
        filename: 'browser_pack.js',
    },
    plugins: [
        new NodePolyfillPlugin(),
        new webpack.IgnorePlugin({
            resourceRegExp: /^archiver|jsdom$/,
        })
    ]
};
