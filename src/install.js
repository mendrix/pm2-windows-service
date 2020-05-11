'use strict';

const path = require('path'),
    co = require('co'),
    event = require('co-event'),
    promisify = require('util').promisify || require('promisify-node'),
    fsx = require('fs-extra'),
    fs = require('fs'),
    exec = promisify(require('child_process').exec),
    Service = require('node-windows').Service,
    inquirer = require('inquirer'),
    common = require('./common'),
    setup = require('./setup');

const PM2_HOME = process.env.PM2_HOME;
const sid_file = path.resolve(PM2_HOME, '.sid');

module.exports = co.wrap(function*(name, description, logpath, no_setup) {

    common.check_platform();

    yield common.admin_warning();

    const PM2_HOME = process.env.PM2_HOME;
    if (!PM2_HOME) {
        throw new Error('PM2_HOME environment variable is not set. This is required for installation.');
    } else {
        if (!fs.existsSync(PM2_HOME)) {
            throw new Error(`The folder specified by PM2_HOME (${PM2_HOME}) does not exist. \nPlease make sure this folder exists before installation.`);
        }
    }
    const PM2_SERVICE_PM2_DIR = process.env.PM2_SERVICE_PM2_DIR;
    if (!PM2_SERVICE_PM2_DIR) {
        throw new Error('PM2_SERVICE_PM2_DIR environment variable is not set. This is required for installation.');
    } else {
        if (!fs.existsSync(PM2_SERVICE_PM2_DIR)) {
            throw new Error(`The file specified by PM2_SERVICE_PM2_DIR (${PM2_SERVICE_PM2_DIR}) does not exist. \nPlease make sure pm2 is properly installed before installation.`);
        }
    }

    let setup_response = yield no_setup ? Promise.resolve({
        perform_setup: false
    }) : inquirer.prompt([{
        type: 'confirm',
        name: 'perform_setup',
        message: 'Perform environment setup (recommended)?',
        default: true
    }]);

    if(setup_response.perform_setup) {
        yield setup();
    }

    let service = new Service({
        name: name || 'PM2',
        description: description,
        script: path.join(__dirname, 'service.js'),
        stopparentfirst: true,
        logging: {
            mode: 'roll-by-time',
            pattern: 'yyyyMMdd'
        },
        logpath: logpath ? logpath : path.join(PM2_HOME, "logs"),
        env: [
            {
                name: "PM2_HOME",
                value: PM2_HOME // service needs PM2_HOME environment var
            },
            {
                name: "PM2_SERVICE_PM2_DIR",
                value: PM2_SERVICE_PM2_DIR // service needs PM2_SERVICE_PM2_DIR environment var
            }]
    });

    // Let this throw if we can't remove previous daemon
    try {
        yield common.remove_previous_daemon(service);
    } catch(ex) {
        throw new Error('Previous daemon still in use, please stop or uninstall existing service before reinstalling.');
    }

    // NOTE: We don't do (name = name || 'PM2') above so we don't end up
    // writing out a sid_file for default name
    yield* save_sid_file(name);

    yield* kill_existing_pm2_daemon();

    yield* install_and_start_service(service);
});

function* save_sid_file(name) {
    if(name) {
        // Save name to %APPDATA%/pm2-windows-service/.sid, if supplied
        console.log(`Service name: ${name} stored in: ${sid_file}.`);
        yield fsx.outputFile(sid_file, name);
    }
}

function* kill_existing_pm2_daemon() {
    try {
        yield exec('pm2 kill');
    } catch (ex) {
        // PM2 daemon wasn't running, no big deal
    }
}

function* install_and_start_service(service) {
    // Make sure we kick off the install events on next tick BEFORE we yield
    setImmediate(_ => service.install());

    // Now yield on install/alreadyinstalled/start events
    let e;
    while (e = yield event(service)) {
        switch (e.type) {
            case 'alreadyinstalled':
            case 'install':
                service.start();
                break;
            case 'start':
                return;
            case 'error':
                console.error('node-windows reports error ', e.args);
                return;
            case 'invalidinstallation':
                console.error('node-windows reports invalid installation ', e.args);
                return;
        }
    }
}
