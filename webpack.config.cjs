const path = require('node:path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');

module.exports = {
    mode: 'production',
    entry: './src/index.ts',
    target: 'node',
    output: {
        filename: 'index.js',
        path: path.resolve(__dirname, 'dist'), // 输出路径
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    optimization: {
        minimize: false,
    },
    plugins: [
        new CleanWebpackPlugin(),
    ],
    devtool: false,
};