const _ = require('lodash');
const os = require('os');
const util = require('util');
const fs = require('fs');
const path = require('path');
const config = require('typed-env-config');
const rimraf = util.promisify(require('rimraf'));
const mkdirp = util.promisify(require('mkdirp'));
const {ClusterSpec} = require('../formats/cluster-spec');
const {TerraformJson} = require('../formats/tf-json');
const {TaskGraph, Lock, ConsoleRenderer, LogRenderer} = require('console-taskgraph');
const {gitClone} = require('./utils');
const generateRepoTasks = require('./repo');

const _kindTaskGenerators = {
  service: require('./service'),
  other: require('./other'),
};

class Build {
  constructor(input, output, cmdOptions) {
    this.input = input;
    this.output = output;
    this.cmdOptions = cmdOptions;

    this.baseDir = cmdOptions['baseDir'] || '/tmp/taskcluster-builder-build';

    this.spec = null;
    this.cfg = null;
  }

  async run() {
    this.spec = new ClusterSpec(this.input);
    this.cfg = config({
      files: [
        'build-config.yml',
        'user-build-config.yml',
      ],
      env:      process.env,
    });

    if (this.cmdOptions.noCache) {
      await rimraf(this.baseDir);
    }
    await mkdirp(this.baseDir);

    let tasks = [];

    this.spec.build.repositories.forEach(repo => {
      generateRepoTasks({
        tasks,
        baseDir: this.baseDir,
        spec: this.spec,
        cfg: this.cfg,
        name: repo.name,
        cmdOptions: this.cmdOptions,
      });

      const kindTaskGenerator = _kindTaskGenerators[repo.kind];
      if (!kindTaskGenerator) {
        throw new Error(`Unknown kind ${repo.kind} for repository ${repo.name}`);
      }

      kindTaskGenerator({
        tasks,
        baseDir: this.baseDir,
        spec: this.spec,
        cfg: this.cfg,
        name: repo.name,
        cmdOptions: this.cmdOptions,
      });
    });

    const taskgraph = new TaskGraph(tasks, {
      locks: {
        // limit ourselves to one docker process per CPU
        docker: new Lock(os.cpus().length),
        // and let's be sane about how many git clones we do..
        git: new Lock(8),
      },
      renderer: process.stdout.isTTY ?
        new ConsoleRenderer({elideCompleted: true}) :
        new LogRenderer(),
    });
    const context = await taskgraph.run();

    // create a TerraformJson output based on the result of the build
    const tfJson = new TerraformJson(this.spec, context);
    // ..and write it out
    tfJson.write(this.output);
  }
}

const main = async (input, output, options) => {
  const build = new Build(input, output, options);
  await build.run();
};

module.exports = main;
