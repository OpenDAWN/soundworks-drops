'use strict';

var clientSide = require('soundworks/client');
var waves = require('waves-audio');
var client = clientSide.client;
var input = clientSide.input;
var SampleSynth = require('./SampleSynth');
var visual = require('./visual/main');

var scheduler = waves.getScheduler();
scheduler.lookahead = 0.050;

function arrayRemove(array, value) {
  var index = array.indexOf(value);

  if (index >= 0) {
    array.splice(index, 1);
    return true;
  }

  return false;
}

function changeBackgroundColor(d) {
  var value = Math.floor(Math.max(1 - d, 0) * 255);
  document.body.style.backgroundColor = 'rgb(' + value + ', ' + value + ', ' + value + ')';
}

class Loop extends waves.TimeEngine {
  constructor(looper, soundParams, local = false) {
    super();
    this.looper = looper;

    this.soundParams = soundParams;
    this.local = local;
  }

  advanceTime(time) {
    return this.looper.advance(time, this);
  }
}

class Looper {
  constructor(synth, updateCount) {
    this.synth = synth;
    this.updateCount = updateCount;

    this.loops = [];
    this.numLocalLoops = 0;
  }

  start(time, soundParams, local = false) {
    var loop = new Loop(this, soundParams, local);
    scheduler.add(loop, time);
    this.loops.push(loop);

    if (local)
      this.numLocalLoops++;

    this.updateCount();
  }

  advance(time, loop) {
    var soundParams = loop.soundParams;

    if (soundParams.gain < soundParams.minGain) {
      arrayRemove(this.loops, loop);

      if (loop.local)
        this.numLocalLoops--;

      this.updateCount();

      return null;
    }

    var duration = this.synth.trigger(time, soundParams, !loop.local);

    visual.createCircle({
      index: soundParams.index,
      x: soundParams.x,
      y: soundParams.y,
      duration: duration,
      velocity: 40 + soundParams.gain * 80,
      opacity: Math.sqrt(soundParams.gain)
    });

    soundParams.gain *= soundParams.loopAttenuation;

    return time + soundParams.loopPeriod;
  }

  remove(index) {
    var loops = this.loops;
    var i = 0;

    while (i < loops.length) {
      var loop = loops[i];

      if (loop.soundParams.index === index) {
        loops.splice(i, 1);

        scheduler.remove(loop);

        if (loop.local) {
          this.numLocalLoops--;
          visual.remove(index);
        }
      } else {
        i++;
      }
    }

    this.updateCount();
  }

  removeAll() {
    for (let loop of this.loops)
      scheduler.remove(loop);

    this.loops = [];
    this.numLocalLoops = 0;

    this.updateCount();
  }
}

class Performance extends clientSide.Performance {
  constructor(loader, control, sync, checkin) {
    super();

    this.loader = loader;
    this.sync = sync;
    this.checkin = checkin;
    this.control = control;
    this.synth = new SampleSynth(null);

    this.index = -1;
    this.numTriggers = 6;

    var canvas = document.createElement('canvas');
    canvas.classList.add('scene');
    canvas.setAttribute('id', 'scene');
    this.view.appendChild(canvas);

    // control parameters
    this.state = 'reset';
    this.maxDrops = 0;
    this.loopDiv = 3;
    this.loopPeriod = 7.5;
    this.loopAttenuation = 0.70710678118655;
    this.minGain = 0.1;
    this.autoPlay = 'off';

    this.quantize = 0;
    this.numLocalLoops = 0;

    this.looper = new Looper(this.synth, () => {
      this.updateCount();
    });

    control.on('control:event', (name, val) => {
      if(name === 'clear')
        this.looper.removeAll();
      else
        this.updateControlParameters();
    });

    input.on('devicemotion', (data) => {
      var accX = data.accelerationIncludingGravity.x;
      var accY = data.accelerationIncludingGravity.y;
      var accZ = data.accelerationIncludingGravity.z;
      var mag = Math.sqrt(accX * accX + accY * accY + accZ * accZ);

      if (mag > 20) {
        this.clear();
        this.autoPlay = 'manual';
      }
    });

    // setup input listeners
    input.on('touchstart', (data) => {
      if (this.state === 'running' && this.looper.numLocalLoops < this.maxDrops) {
        var x = (data.coordinates[0] - this.view.offsetLeft + window.scrollX) / this.view.offsetWidth;
        var y = (data.coordinates[1] - this.view.offsetTop + window.scrollY) / this.view.offsetHeight;

        this.trigger(x, y);
      }

      this.autoPlay = 'manual';
    });

    // setup performance control listeners
    client.receive('performance:echo', (serverTime, soundParams) => {
      var time = this.sync.getLocalTime(serverTime);
      this.looper.start(time, soundParams);
    });

    client.receive('performance:clear', (index) => {
      this.looper.remove(index);
    });
  }

  trigger(x, y) {
    var soundParams = {
      index: this.index,
      gain: 1,
      x: x,
      y: y,
      loopDiv: this.loopDiv,
      loopPeriod: this.loopPeriod,
      loopAttenuation: this.loopAttenuation,
      minGain: this.minGain
    };

    var time = scheduler.currentTime;
    var serverTime = this.sync.getSyncTime(time);

    // quantize
    if (this.quantize > 0) {
      serverTime = Math.ceil(serverTime / this.quantize) * this.quantize;
      time = this.sync.getLocalTime(serverTime);
    }

    this.looper.start(time, soundParams, true);
    client.send('performance:sound', serverTime, soundParams);
  }

  clear() {
    var index = this.index;

    // remove at own looper
    this.looper.remove(index, true);

    // remove at other players
    client.send('performance:clear', index);
  }

  updateCount() {
    var str = "";

    if (this.state === 'reset') {
      str = "<p>Waiting for<br>everybody<br>getting ready…</p>";
    } else if (this.state === 'end' && this.looper.loops.length === 0) {
      str = "<p>That's all.<br>Thanks!</p>";
    } else {
      var numAvailable = Math.max(0, this.maxDrops - this.looper.numLocalLoops);

      if (numAvailable > 0) {
        str = "<p>You have</p>";

        if (numAvailable === this.maxDrops) {
          if (numAvailable === 1)
            str += "<p class='big'>1</p> <p>drop to play</p>";
          else
            str += "<p class='big'>" + numAvailable + "</p> <p>drops to play</p>";
        } else
          str += "<p class='big'>" + numAvailable + " of " + this.maxDrops + "</p> <p>drops to play</p>";
      } else
        str = "<p class='listen'>Listen!</p>";
    }

    this.setCenteredViewContent(str);
  }

  updateControlParameters() {
    var events = this.control.events;

    if (events.state.value !== this.state ||  events.maxDrops.value !== this.maxDrops) {
      this.state = events.state.value;
      this.maxDrops = events.maxDrops.value;
      this.updateCount();
    }

    this.loopDiv = events.loopDiv.value;
    this.loopPeriod = events.loopPeriod.value;
    this.loopAttenuation = events.loopAttenuation.value;
    this.minGain = events.minGain.value;

    if (this.autoPlay != 'manual' && events.autoPlay != this.autoPlay) {
      this.autoPlay = events.autoPlay.value;

      if (events.autoPlay.value === 'on') {
        this.autoTrigger();
        this.autoClear();
      }
    }
  }

  autoTrigger() {
    if (this.autoPlay === 'on') {
      if (this.state === 'running' && this.looper.numLocalLoops < this.maxDrops)
        this.trigger(Math.random(), Math.random());

      setTimeout(() => {
        this.autoTrigger();
      }, Math.random() * 2000 + 50);
    }
  }

  autoClear() {
    if (this.autoPlay === 'on') {
      if (this.looper.numLocalLoops > 0)
        this.clear(Math.random(), Math.random());

      setTimeout(() => {
        this.autoClear();
      }, Math.random() * 60000 + 60000);
    }
  }

  start() {
    super.start();

    this.index = this.checkin.index;

    this.updateControlParameters();

    visual.start();

    this.updateCount();

    input.enableTouch(this.view);
    input.enableDeviceMotion();

    this.synth.audioBuffers = this.loader.buffers;

    // for testing
    if (this.autoPlay) {
      this.autoTrigger();
      this.autoClear();
    }
  }
}

module.exports = Performance;