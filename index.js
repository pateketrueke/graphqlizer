'use strict';

const glob = require('glob');
const path = require('path');
const fs = require('fs');

module.exports = callback => {
  let _schema;

  const graphql = require('graphql').graphql;
  const graphqlSequelize = require('graphql-sequelize');
  const mergeTypes = require('merge-graphql-schemas').mergeTypes;
  const mergeResolvers = require('merge-graphql-schemas').mergeResolvers;
  const makeExecutableSchema = require('graphql-tools').makeExecutableSchema;

  // static interface
  const _graphql = (schema, args, ctx) =>
    graphql({
      schema: _graphql.schema,
      source: schema,
      contextValue: ctx,
      variableValues: args,
    });

  // attach references
  _graphql.schemas = [];
  _graphql.resolvers = [];

  // attach graphql-sequelize
  _graphql.model = modelName => {
    if (typeof callback !== 'function') {
      throw new Error('Missing model resolver');
    }

    const _cache = {};

    return function resolver() {
      let _wrapper;

      try {
        const model = callback(modelName, arguments[1], arguments[2]);
        const key = `${model.sequelize.options.identifier}_${model.name}`;

        // avoid wrapping too much!
        if (!_cache[key]) {
          _wrapper = _cache[key] = graphqlSequelize.resolver(model);
        } else {
          _wrapper = _cache[key];
        }
      } catch (e) {
        throw new Error(`Unable to resolve(${modelName}). ${e.message}`);
      }

      return _wrapper.apply(null, arguments);
    };
  };

  // instantiate types and such
  _graphql.load = (definitions, cb) => {
    Object.keys(definitions).forEach(name => {
      if (definitions[name].options.$graphql && !definitions[name].virtual) {
        const fields = graphqlSequelize.attributeFields(definitions[name]);

        Object.keys(definitions[name].attributes).forEach(k => {
          const values = definitions[name].attributes[k].type.values;
          const field = fields[k].type.name;

          if (field && values) {
            _graphql.schemas.push(`enum ${field} {\n  ${values.join('\n  ')}\n}`);
          }
        });

        _graphql.schemas.push(`type ${name} {\n  ${Object.keys(fields)
          .map(k => `${k}: ${fields[k].type}`)
          .join('\n  ')}\n}`);
      }
    });

    return _graphql;
  };

  // load definitions
  _graphql.scan = (paths, cb) => {
    const definitions = (!Array.isArray(paths) ? [paths] : paths)
      .reduce((prev, cur) => {
        if (cur.indexOf('.graphql') === -1 && cur.indexOf('.gql') === -1 && cur.indexOf('.js') === -1) {
          Array.prototype.push.apply(prev,
            glob.sync('**/*.{js,gql,graphql}', { cwd: cur }).map(x => path.join(cur, x)));
        } else {
          prev.push(cur);
        }

        return prev;
      }, []);

    definitions.forEach(file => {
      const name = path.basename(file);

      if (/resolvers?/i.test(name) || /mutat(?:or|ion)/i.test(name)) {
        let resolver = require(file);

        if (typeof resolver === 'function') {
          resolver = typeof cb === 'function'
            ? cb(resolver)
            : resolver();
        }

        _graphql.resolvers.push(resolver);
      }

      if (name === 'schema.graphql' || name === 'schema.gql') {
        _graphql.schemas.push(fs.readFileSync(file).toString().trim());
      }
    });

    return _graphql;
  };

  _graphql.add = (definitions, cb) => {
    definitions.forEach(x => {
      if (x.$graphql) {
        _graphql.schemas.push(x.$graphql);
      }

      if (x.graphqlMutators) {
        _graphql.resolvers.push(typeof cb === 'function'
          ? cb(x.graphqlMutators)
          : x.graphqlMutators);
      }

      if (x.graphqlResolvers) {
        _graphql.resolvers.push(typeof cb === 'function'
          ? cb(x.graphqlResolvers)
          : x.graphqlResolvers);
      }
    });

    return _graphql;
  };

  // lazy loading
  Object.defineProperty(_graphql, 'schema', {
    configurable: false,
    enumerable: false,
    get() {
      if (!_schema) {
        if (!_graphql.schemas.length) {
          throw new Error('Missing schemas for GraphQL');
        }

        try {
          _schema = makeExecutableSchema({
            typeDefs: mergeTypes(_graphql.schemas),
            resolvers: _graphql.resolvers.length > 0
              ? mergeResolvers(_graphql.resolvers)
              : {},
          });
        } catch (e) {
          throw new Error(`Unable to start GraphQL. ${e.message}`);
        }
      }

      return _schema;
    },
    set() {
      throw new Error('GraphQL-Schema is read-only');
    },
  });

  return _graphql;
};
