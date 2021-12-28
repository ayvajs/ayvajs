import {
  clamp, round, has, fail, createConstantProperty
} from './util.js';

// TODO: Better filtering of NaN/Infinity values...? We're calling isFinite all over the place...
//       Double check moving to the same position I'm already at...
//       And rounding errors on home()...
class Ayva {
  #devices = [];

  #axes = {};

  #frequency = 50; // Hz

  #movementInProgress = false;

  #movements = new Set();

  #nextMovementId = 1;

  get axes () {
    return JSON.parse(JSON.stringify(this.#axes));
  }

  get frequency () {
    return this.#frequency;
  }

  get period () {
    return this.#period;
  }

  get #period () {
    return 1 / this.#frequency;
  }

  /**
   * Create a new instance of Ayva with the specified configuration.
   *
   * @param {Object} [config]
   * @param {String} [config.name] - the name of this configuration
   * @param {String} [config.defaultAxis] - the default axis to command when no axis is specified
   * @param {Object[]} [config.axes] - an array of axis configurations (see {@link Ayva#configureAxis})
   * @class Ayva
   */
  constructor (config) {
    if (config) {
      this.name = config.name;
      this.defaultAxis = config.defaultAxis;
      this.#frequency = (config.frequency || this.#frequency);

      if (config.axes) {
        config.axes.forEach((axis) => {
          this.configureAxis(axis);
        });
      }
    }
  }

  /**
   * Performs movements or updates along one or more axes. This is a powerful method that can synchronize
   * axis movement while allowing for fine control over position, speed, and move duration.
   * For full details on how to use this method, see the {@tutorial motion-api} tutorial.
   *
   * @example
   * ayva.move({
   *   axis: 'stroke',
   *   to: 0,
   *   speed: 1,
   * },{
   *   axis: 'twist',
   *   to: 0.5,
   *   speed: 0.5,
   * });
   *
   * @param  {Object} movements
   * @return {Promise} a promise that resolves when all movements have finished
   */
  async move (...movements) {
    this.#validateMovements(movements);

    const movementId = this.#nextMovementId++;
    this.#movements.add(movementId);

    if (this.#movementInProgress) {
      while (this.#movementExists(movementId) && !this.#movementReady(movementId)) {
        await this.sleep(); // eslint-disable-line no-await-in-loop
      }
    }

    if (!this.#movementExists(movementId)) {
      // This move was cancelled.
      return false;
    }

    try {
      this.#movementInProgress = true;
      return await this.#performMovements(movementId, movements);
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#movementInProgress = false;
      this.#movements.delete(movementId);
    }
  }

  /**
   * Moves all linear and rotation axes to their neutral positions.
   *
   * @param {Number} [to = 0.5] - optional target position to home to.
   * @param {Number} [speed = 0.5] - optional speed of the movement.
   * @return {Promise} A promise that resolves when the movements are finished.
   */
  async home (to = 0.5, speed = 0.5) {
    const movements = this.#getAxesArray()
      .filter((axis) => axis.type === 'linear' || axis.type === 'rotation')
      .map((axis) => ({ to, speed, axis: axis.name }));

    if (movements.length) {
      return this.move(...movements);
    }

    console.warn('No linear or rotation axes configured.'); // eslint-disable-line no-console
    return Promise.resolve();
  }

  /**
   * Cancels all running or pending movements immediately.
   */
  stop () {
    this.#movements.clear();
  }

  /**
   * Asynchronously sleep for the specified number of seconds.
   *
   * TODO: Externalize this into a timer that can be swapped out.
   *
   * @param {*} seconds
   * @returns {Promise} a Promise that resolves when the number of seconds have passed.
   */
  async sleep (seconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, seconds * 1000);
    });
  }

  /**
   * Configures a new axis. If an axis with the same name has already been configured, it will be overridden.
   *
   * @example
   * const ayva = new Ayva();
   *
   * ayva.configureAxis({
   *   name: 'L0',
   *   type: 'linear',
   *   alias: 'stroke',
   *   max: 0.9,
   *   min: 0.3,
   * });
   *
   * @param {Object} axisConfig - axis configuration object
   * @param {String} axisConfig.name - the machine name of this axis (such as L0, R0, etc...)
   * @param {String} axisConfig.type - linear, rotation, auxiliary, or boolean
   * @param {String|String[]} [axisConfig.alias] - an alias used to refer to this axis
   * @param {Object} [axisConfig.max = 1] - specifies maximum value for this axis (not applicable for boolean axes)
   * @param {Number} [axisConfig.min = 0] - specifies minimum value for this axis (not applicable for boolean axes)
   */
  configureAxis (axisConfig) {
    const resultConfig = this.#validateAxisConfig(axisConfig);

    const oldConfig = this.#axes[axisConfig.name];

    if (oldConfig) {
      resultConfig.value = oldConfig.value;
      delete this.#axes[oldConfig.alias];
    }

    this.#axes[axisConfig.name] = resultConfig;

    if (axisConfig.alias) {
      if (this.#axes[axisConfig.alias]) {
        throw new Error(`Alias already refers to another axis: ${axisConfig.alias}`);
      }

      this.#axes[axisConfig.alias] = resultConfig;
    }
  }

  /**
   * Fetch an immutable object containing the properties for an axis.
   *
   * @param {String} name - the name or alias of the axis to get.
   * @return {Object} axisConfig - an immutable object of axis properties.
   */
  getAxis (name) {
    const fetchedAxis = this.#axes[name];

    if (fetchedAxis) {
      const axis = {};

      Object.keys(fetchedAxis).forEach((key) => {
        createConstantProperty(axis, key, fetchedAxis[key]);
      });

      return axis;
    }

    return undefined;
  }

  /**
   * Update the limits for the specified axis.
   *
   * @param {*} axis
   * @param {*} from - value between 0 and 1
   * @param {*} to - value between 0 and 1
   */
  updateLimits (axis, from, to) {
    const isInvalid = (value) => !Number.isFinite(value) || value < 0 || value > 1;

    if (isInvalid(from) || isInvalid(to) || from === to) {
      throw new Error(`Invalid limits: min = ${from}, max = ${to}`);
    }

    if (!this.#axes[axis]) {
      throw new Error(`Invalid axis: ${axis}`);
    }

    this.#axes[axis].min = Math.min(from, to);
    this.#axes[axis].max = Math.max(from, to);
  }

  /**
   * Alias for #addOutputDevice()
   *
   * @ignore
   * @param {...Object} device - object with a write method.
   */
  addOutputDevices (...devices) {
    for (const device of devices) {
      if (!(device && device.write && device.write instanceof Function)) {
        throw new Error(`Invalid device: ${device}`);
      }
    }

    this.#devices.push(...devices);
  }

  /**
   * Registers a new output device. Ayva outputs commands to all connected devices.
   * More than one device can be specified.
   *
   * @param {...Object} device - object with a write method.
   */
  addOutputDevice (...devices) {
    this.addOutputDevices(...devices);
  }

  /**
   * Writes the specified command out to all connected devices.
   *
   * TODO: Refactor into update method.
   *
   * Caution: This method is primarily intended for internal usage. Any movements performed
   * by the command will not be tracked by Ayva's internal position tracking.
   * @private
   */
  write (command) {
    if (!this.#devices || !this.#devices.length) {
      throw new Error('No output devices have been added.');
    }

    if (!(typeof command === 'string' || command instanceof String)) {
      throw new Error(`Invalid command: ${command}`);
    }

    if (!(command.trim() && command.trim().length)) {
      throw new Error('Cannot send a blank command.');
    }

    for (const device of this.#devices) {
      device.write(command);
    }
  }

  async #performMovements (movementId, movements) {
    const allProviders = this.#createValueProviders(movements);
    const stepCount = this.#computeStepCount(allProviders);
    const immediateProviders = allProviders.filter((provider) => !provider.parameters.stepCount);
    const stepProviders = allProviders.filter((provider) => !!provider.parameters.stepCount);

    this.#executeProviders(immediateProviders, 0);
    for (let index = 0; index < stepCount; index++) {
      const unfinishedProviders = stepProviders.filter((provider) => index < provider.parameters.stepCount);
      this.#executeProviders(unfinishedProviders, index);

      await this.sleep(this.#period); // eslint-disable-line no-await-in-loop

      if (!this.#movementExists(movementId)) {
        // This move was cancelled.
        return false;
      }
    }

    return true;
  }

  #movementExists (movementId) {
    return this.#movements.has(movementId);
  }

  #movementReady (movementId) {
    return !this.#movementInProgress && this.#movements.values().next().value === movementId;
  }

  #executeProviders (providers, index) {
    const axisValues = providers
      .map((provider) => this.#executeProvider(provider, index))
      .filter(({ value }) => Number.isFinite(value) || typeof value === 'boolean');

    const tcodes = axisValues.map(({ axis, value }) => this.#tcode(axis, typeof value === 'number' ? round(value * 0.999, 3) : value));

    if (tcodes.length) {
      this.write(`${tcodes.join(' ')}\n`);

      axisValues.forEach(({ axis, value }) => {
        this.#axes[axis].value = value;
      });
    }
  }

  #executeProvider (provider, index) {
    const time = index * this.#period;
    const { parameters, valueProvider } = provider;

    const nextValue = valueProvider({
      ...parameters,
      time,
      index,
      period: this.#period,
      frequency: this.#frequency,
      currentValue: this.#axes[parameters.axis].value,
      x: (index + 1) / provider.parameters.stepCount,
    });

    const notNullOrUndefined = nextValue !== null && nextValue !== undefined; // Allow null or undefined to indicate no movement.

    if (!Number.isFinite(nextValue) && typeof nextValue !== 'boolean' && notNullOrUndefined) {
      console.warn(`Invalid value provided: ${nextValue}`); // eslint-disable-line no-console
    }

    return {
      axis: parameters.axis,
      value: Number.isFinite(nextValue) ? clamp(round(nextValue, 10), 0, 1) : nextValue,
    };
  }

  /**
   * Converts the value into a standard TCode string for the specified axis. (i.e. 0.5 -> L0500)
   * If the axis is a boolean axis, true values get mapped to 999 and false gets mapped to 000.
   *
   * @param {*} axis
   * @param {*} value
   * @returns {String} the TCode string
   */
  #tcode (axis, value) {
    let valueText;

    if (typeof value === 'boolean') {
      valueText = value ? '999' : '000';
    } else {
      const { min, max } = this.#axes[axis];
      const scaledValue = (max - min) * value + min;

      valueText = `${clamp(round(scaledValue, 3) * 1000, 0, 999)}`.padStart(3, '0');
    }

    return `${this.#axes[axis].name}${valueText}`;
  }

  /**
   * Create value providers with initial parameters.
   *
   * Precondition: Each movement is a valid movement per the Motion API.
   * @param {*} movements
   * @returns {Object[]} - array of value providers with parameters.
   */
  #createValueProviders (movements) {
    let maxDuration = 0;

    const computedMovements = movements.map((movement) => {
      // Initialize all parameters that we can deduce.
      const axis = movement.axis || this.defaultAxis;

      const result = {
        ...movement,
        axis,
        from: this.#axes[axis].value,
        period: this.#period,
      };

      if (has(movement, 'to')) {
        const distance = movement.to - result.from;
        const absoluteDistance = Math.abs(distance);

        if (has(movement, 'duration')) {
          // { to: <number>, duration: <number> }
          result.speed = round(absoluteDistance / movement.duration, 10);
        } else if (has(movement, 'speed')) {
          // { to: <number>, speed: <number> }
          result.duration = round(absoluteDistance / movement.speed, 10);
        }

        result.direction = distance > 0 ? 1 : distance < 0 ? -1 : 0; // eslint-disable-line no-nested-ternary
      }

      if (has(result, 'duration')) {
        maxDuration = result.duration > maxDuration ? result.duration : maxDuration;
      }

      return result;
    });

    const movementsByAxis = computedMovements.reduce((map, p) => {
      map[p.axis] = p;
      return map;
    }, {});

    computedMovements.forEach((movement) => {
      // We need to compute the duration for any movements we couldn't in the first pass.
      // This will be either implicit or explicit sync movements.
      if (has(movement, 'sync')) {
        // Excplicit sync.
        let syncMovement = movement;

        while (has(syncMovement, 'sync')) {
          syncMovement = movementsByAxis[syncMovement.sync];
        }

        movement.duration = syncMovement.duration || maxDuration;

        if (has(movement, 'to')) {
          // Now we can compute a speed.
          movement.speed = round(Math.abs(movement.to - movement.from) / movement.duration, 10);
        }
      } else if (!has(movement, 'duration') && this.#axes[movement.axis].type !== 'boolean') {
        // Implicit sync to max duration.
        movement.duration = maxDuration;
      }

      if (has(movement, 'duration')) {
        movement.stepCount = round(movement.duration * this.#frequency);
      } // else if (this.#axes[movement.axis].type !== 'boolean') {
      // By this point, the only movements without a duration should be boolean.
      // This should literally never happen because of validation. But including here for debugging and clarity.
      // fail(`Unable to compute duration for movement along axis: ${movement.axis}`);
      // }
    });

    // Create the actual value providers.
    return computedMovements.map((movement) => {
      const provider = {};

      if (!has(movement, 'value')) {
        // Create a value provider from parameters.
        if (this.#axes[movement.axis].type === 'boolean') {
          provider.valueProvider = () => movement.to;
        } else if (movement.to !== movement.from) {
          provider.valueProvider = ({ from, to, x }) => from + x * (to - from);
        } else {
          // No movement.
          provider.valueProvider = () => {};
        }
      } else {
        // User provided value provider.
        provider.valueProvider = movement.value;
      }

      delete movement.sync;
      delete movement.value;
      provider.parameters = movement;

      return provider;
    });
  }

  /**
   * Compute the total steps of the move given a list of value providers.
   * i.e. The maximum number of steps.
   *
   * @param {Object[]} valueProviders
   */
  #computeStepCount (valueProviders) {
    let maxStepCount = 0;

    valueProviders.forEach((provider) => {
      const steps = provider.parameters.stepCount;

      if (steps) {
        maxStepCount = steps > maxStepCount ? steps : maxStepCount;
      }
    });

    return maxStepCount;
  }

  /**
   * All the validation on movement descriptors :O
   *
   * TODO: Clean this up and maybe move some of this out into a generic, parameterizable validator.
   *
   * @param {*} movements
   */
  #validateMovements (movements) {
    const movementMap = {};
    let atLeastOneDuration = false;
    let atLeastOneNonBoolean = false;

    if (!movements || !movements.length) {
      fail('Must supply at least one movement.');
    }

    movements.forEach((movement) => {
      if (!movement || typeof movement !== 'object') {
        fail(`Invalid movement: ${movement}`);
      }

      const invalidValue = (name) => fail(`Invalid value for parameter '${name}': ${movement[name]}`);
      const hasTo = has(movement, 'to');
      const hasSpeed = has(movement, 'speed');
      const hasDuration = has(movement, 'duration');
      const hasValue = has(movement, 'value');
      const axis = movement.axis || this.defaultAxis;

      if (!axis) {
        fail('No default axis configured. Must specify an axis for each movement.');
      }

      if (has(movement, 'axis')) {
        if (typeof movement.axis !== 'string' || !movement.axis.trim() || !this.#axes[movement.axis]) {
          invalidValue('axis');
        }
      }

      if (hasTo) {
        let invalidTo = false;

        if (this.#axes[axis].type === 'boolean') {
          invalidTo = typeof movement.to !== 'boolean';
        } else {
          invalidTo = !Number.isFinite(movement.to) || (movement.to < 0 || movement.to > 1);
        }

        if (invalidTo) {
          invalidValue('to');
        }
      } else if (!hasValue) {
        fail('Must provide a \'to\' property or \'value\' function.');
      }

      if (hasSpeed && hasDuration) {
        fail('Cannot supply both speed and duration.');
      }

      if (hasSpeed || hasDuration) {
        atLeastOneDuration = true;

        if (hasSpeed && (!Number.isFinite(movement.speed) || movement.speed <= 0)) {
          invalidValue('speed');
        } else if (hasDuration && (!Number.isFinite(movement.duration) || movement.duration <= 0)) {
          invalidValue('duration');
        }
      }

      if (hasSpeed && !hasTo) {
        fail('Must provide a target position when specifying speed.');
      }

      if (hasValue && typeof movement.value !== 'function') {
        fail('\'value\' must be a function.');
      }

      if (has(movement, 'sync')) {
        if (typeof movement.sync !== 'string' || !movement.sync.trim()) {
          invalidValue('sync');
        }

        if (has(movement, 'speed') || has(movement, 'duration')) {
          fail(`Cannot specify a speed or duration when sync property is present: ${movement.axis}`);
        }
      }

      if (this.#axes[axis].type !== 'boolean') {
        atLeastOneNonBoolean = true;
      } else {
        if (has(movement, 'speed')) {
          fail(`Cannot specify speed for boolean axes: ${axis}`);
        }

        if (has(movement, 'duration') && hasTo && !hasValue) {
          // { to: <boolean>, duration: <number> } is invalid (for now).
          fail('Cannot specify a duration for a boolean axis movement with constant value.');
        }
      }

      if (movementMap[axis]) {
        fail(`Duplicate axis movement: ${axis}`);
      }

      movementMap[axis] = movement;
    });

    movements.forEach((movement) => {
      let syncMovement = movement;
      const originalMovementAxis = movement.axis;

      while (has(syncMovement, 'sync')) {
        if (!movementMap[syncMovement.sync]) {
          fail(`Cannot sync with axis not specified in movement: ${syncMovement.axis} -> ${syncMovement.sync}`);
        }

        syncMovement = movementMap[syncMovement.sync];

        if (syncMovement.sync === originalMovementAxis) {
          fail('Sync axes cannot form a cycle.');
        }
      }
    });

    if (!atLeastOneDuration && atLeastOneNonBoolean) {
      fail('At least one movement must have a speed or duration.');
    }
  }

  /**
   * Ensure all required fields are present in the configuration and that all are of valid types.
   *
   * TODO: Maybe move some of this out into a generic validator that takes a validation spec.
   * @param {Object} axisConfig
   */
  #validateAxisConfig (axisConfig) {
    if (!axisConfig || typeof axisConfig !== 'object') {
      fail(`Invalid configuration object: ${axisConfig}`);
    }

    const required = ['name', 'type'];

    const types = {
      name: 'string',
      type: 'string',
      alias: 'string',
      max: 'number',
      min: 'number',
    };

    const missing = required.filter(
      (property) => axisConfig[property] === undefined || axisConfig[property] === null
    ).sort();

    if (missing.length) {
      fail(`Configuration is missing properties: ${missing.join(', ')}`);
    }

    const invalid = [];

    Object.keys(types).forEach((property) => {
      const value = axisConfig[property];

      // Since we've already caught missing required fields by this point,
      // we only need to check types of optional fields if they are actually present.
      if (value !== undefined && value !== null) {
        // eslint-disable-next-line valid-typeof
        if (typeof value !== types[property]) {
          invalid.push(property);
        } else if (property === 'min' || property === 'max') {
          if (!Number.isFinite(value) || value < 0 || value > 1) {
            invalid.push(property);
          }
        }
      }
    });

    if (invalid.length) {
      const message = invalid.sort().map((property) => `${property} = ${axisConfig[property]}`).join(', ');
      fail(`Invalid configuration parameter(s): ${message}`);
    }

    if (['linear', 'rotation', 'auxiliary', 'boolean'].indexOf(axisConfig.type) === -1) {
      fail(`Invalid type. Must be linear, rotation, auxiliary, or boolean: ${axisConfig.type}`);
    }

    const resultConfig = {
      ...axisConfig,
      max: axisConfig.max || 1,
      min: axisConfig.min || 0,
      value: axisConfig.type === 'boolean' ? false : 0.5, // Default value. 0.5 is home position for linear, rotation, and auxiliary.
    };

    if (resultConfig.max === resultConfig.min || resultConfig.min > resultConfig.max) {
      fail(`Invalid configuration parameter(s): max = ${resultConfig.max}, min = ${resultConfig.min}`);
    }

    return resultConfig;
  }

  #getAxesArray () {
    const uniqueAxes = {};

    Object.values(this.#axes).forEach((axis) => {
      uniqueAxes[axis.name] = axis;
    });

    function sortByName (a, b) {
      return a.name > b.name ? 1 : -1;
    }

    return Object.values(uniqueAxes).sort(sortByName);
  }
}

// Separate default export from the class declaration because of jsdoc shenanigans...
export default Ayva;
