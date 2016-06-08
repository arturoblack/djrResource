/**
 * @license DjrResoruce - Django REST Resource for AngularJS v1.5.6
 * (c) 2016-2016
 * License: MIT
*/
(function(window, angular) {'use strict';
  var $resourceMinErr = angular.$$minErr('$djrResource');

  // Helper functions and regex to lookup a dotted path on an object
  // stopping at undefined/null.  The path must be composed of ASCII
  // identifiers (just like $parse)
  var MEMBER_NAME_REGEX = /^(\.[a-zA-Z_$@][0-9a-zA-Z_$@]*)+$/;

  function isValidDottedPath(path) {
    return (path !== null && path !== '' && path !== 'hasOwnProperty' &&
        MEMBER_NAME_REGEX.test('.' + path));
  }

  function lookupDottedPath(obj, path) {
    if (!isValidDottedPath(path)) {
      throw $resourceMinErr('badmember', 'Dotted member path "@{0}" is invalid.', path);
    }
    var keys = path.split('.');
    for (var i = 0, ii = keys.length; i < ii && angular.isDefined(obj); i++) {
      var key = keys[i];
      obj = (obj !== null) ? obj[key] : undefined;
    }
    return obj;
  }

  /**
   * Create a shallow copy of an object and clear other fields from the destination
   */
  function shallowClearAndCopy(src, dst) {
    dst = dst || {};

    angular.forEach(dst, function(value, key) {
      delete dst[key];
    });

    for (var key in src) {
      if (src.hasOwnProperty(key) && !(key.charAt(0) === '$' && key.charAt(1) === '$')) {
        dst[key] = src[key];
      }
    }

    return dst;
  }

  /*
   * Licence and
   * Documentation
  */

  angular.module('DjRResources', ['ng']).
    provider('$djrResource', function() {
      var PROTOCOL_AND_DOMAIN_REGEX = /^https?:\/\/[^\/]*/;
      var provider = this;

      this.defaults = {
        // Strip slashes by default
        stripTrailingSlashes: true,
        // Default actions configuration
        actions: {
          'get': {method: 'GET'},
          'save': {method: 'POST'},
          'query': {method: 'GET', isArray: true},
          'remove': {method: 'DELETE'},
          'delete': {method: 'DELETE'}
        }
      };

      this.$get = ['$http', '$log', '$q', '$timeout', function($http, $log, $q, $timeout) {
        var noop = angular.noop,
          forEach = angular.forEach,
          extend = angular.extend,
          copy = angular.copy,
          isFunction = angular.isFunction;

        /**
         * We need our custom method because encodeURIComponent is too aggressive and doesn't follow
         * http://www.ietf.org/rfc/rfc3986.txt with regards to the character set
         * (pchar) allowed in path segments:
         *    segment       = *pchar
         *    pchar         = unreserved / pct-encoded / sub-delims / ":" / "@"
         *    pct-encoded   = "%" HEXDIG HEXDIG
         *    unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
         *    sub-delims    = "!" / "$" / "&" / "'" / "(" / ")"
         *                     / "*" / "+" / "," / ";" / "="
         */
        function encodeUriSegment(val) {
          return encodeUriQuery(val, true).
            replace(/%26/gi, '&').
            replace(/%3D/gi, '=').
            replace(/%2B/gi, '+');
        }

        /**
         * This method is intended for encoding *key* or *value* parts of query component. We need a
         * custom method because encodeURIComponent is too aggressive and encodes stuff that doesn't
         * have to be encoded per http://tools.ietf.org/html/rfc3986:
         *    query       = *( pchar / "/" / "?" )
         *    pchar         = unreserved / pct-encoded / sub-delims / ":" / "@"
         *    unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
         *    pct-encoded   = "%" HEXDIG HEXDIG
         *    sub-delims    = "!" / "$" / "&" / "'" / "(" / ")"
         *                     / "*" / "+" / "," / ";" / "="
         */
        function encodeUriQuery(val, pctEncodeSpaces) {
          return encodeURIComponent(val).
            replace(/%40/gi, '@').
            replace(/%3A/gi, ':').
            replace(/%24/g, '$').
            replace(/%2C/gi, ',').
            replace(/%20/g, (pctEncodeSpaces ? '%20' : '+'));
        }

        function Route(template, defaults) {
          this.template = template;
          this.defaults = extend({}, provider.defaults, defaults);
          this.urlParams = {};
        }

        Route.prototype = {
          setUrlParams: function(config, params, actionUrl) {
            var self = this,
              url = actionUrl || self.template,
              val,
              encodedVal,
              protocolAndDomain = '';

            var urlParams = self.urlParams = {};
            forEach(url.split(/\W/), function(param) {
              if (param === 'hasOwnProperty') {
                throw $resourceMinErr('badname', "hasOwnProperty is not a valid parameter name.");
              }
              if (!(new RegExp("^\\d+$").test(param)) && param &&
                (new RegExp("(^|[^\\\\]):" + param + "(\\W|$)").test(url))) {
                urlParams[param] = {
                  isQueryParamValue: (new RegExp("\\?.*=:" + param + "(?:\\W|$)")).test(url)
                };
              }
            });
            url = url.replace(/\\:/g, ':');
            url = url.replace(PROTOCOL_AND_DOMAIN_REGEX, function(match) {
              protocolAndDomain = match;
              return '';
            });

            params = params || {};
            forEach(self.urlParams, function(paramInfo, urlParam) {
              val = params.hasOwnProperty(urlParam) ? params[urlParam] : self.defaults[urlParam];
              if (angular.isDefined(val) && val !== null) {
                if (paramInfo.isQueryParamValue) {
                  encodedVal = encodeUriQuery(val, true);
                } else {
                  encodedVal = encodeUriSegment(val);
                }
                url = url.replace(new RegExp(":" + urlParam + "(\\W|$)", "g"), function(match, p1) {
                  return encodedVal + p1;
                });
              } else {
                url = url.replace(new RegExp("(\/?):" + urlParam + "(\\W|$)", "g"), function(match,
                    leadingSlashes, tail) {
                  if (tail.charAt(0) == '/') {
                    return tail;
                  } else {
                    return leadingSlashes + tail;
                  }
                });
              }
            });

            // strip trailing slashes and set the url (unless this behavior is specifically disabled)
            if (self.defaults.stripTrailingSlashes) {
              url = url.replace(/\/+$/, '') || '/';
            }

            // then replace collapse `/.` if found in the last URL path segment before the query
            // E.g. `http://url.com/id./format?q=x` becomes `http://url.com/id.format?q=x`
            url = url.replace(/\/\.(?=\w+($|\?))/, '.');
            // replace escaped `/\.` with `/.`
            config.url = protocolAndDomain + url.replace(/\/\\\./, '/.');


            // set params - delegate param encoding to $http
            forEach(params, function(value, key) {
              if (!self.urlParams[key]) {
                config.params = config.params || {};
                config.params[key] = value;
              }
            });
          }
        };

        function djrResourceFactory(){
          var route = new Route(url, options);

          actions = extend({}, provider.defaults.actions, actions);

          function extractParams(data, actionParams) {
            var ids = {};
            actionParams = extend({}, paramDefaults, actionParams);
            forEach(actionParams, function(value, key) {
              if (isFunction(value)) { value = value(); }
              ids[key] = value && value.charAt && value.charAt(0) == '@' ?
                lookupDottedPath(data, value.substr(1)) : value;
            });
            return ids;
          }

          function defaultResponseInterceptor(response) {
            return response.resource;
          }

          function DjrResource(value) {
            shallowClearAndCopy(value || {}, this);
          }

          DjrResource.prototype.toJSON = function() {
            var data = extend({}, this);
            delete data.$promise;
            delete data.$resolved;
            return data;
          };


        }



      }]; //END of this.$get

    }); // END of PROVIDER


})(window, window.angular);

angular.module('djrResources', ['ng']).
  factory('djResource', ['$http', '$parse', function($http, $parse) {
    var DEFAULT_ACTIONS = {
      'get':    {method:'GET'},
      'save':   {method:'POST', method_if_field_has_value: ['id','PUT']},
      'update': {method:'PUT'},
      'query':  {method:'GET', isArray:true},
      'remove': {method:'DELETE'},
      'delete': {method:'DELETE'}
    };
    var noop = angular.noop,
        forEach = angular.forEach,
        extend = angular.extend,
        copy = angular.copy,
        isFunction = angular.isFunction,
        getter = function(obj, path) {
          return $parse(path)(obj);
        };

    /**
     * We need our custom method because encodeURIComponent is too aggressive and doesn't follow
     * http://www.ietf.org/rfc/rfc3986.txt with regards to the character set (pchar) allowed in path
     * segments:
     *    segment       = *pchar
     *    pchar         = unreserved / pct-encoded / sub-delims / ":" / "@"
     *    pct-encoded   = "%" HEXDIG HEXDIG
     *    unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
     *    sub-delims    = "!" / "$" / "&" / "'" / "(" / ")"
     *                     / "*" / "+" / "," / ";" / "="
     */
    function encodeUriSegment(val) {
      return encodeUriQuery(val, true).
        replace(/%26/gi, '&').
        replace(/%3D/gi, '=').
        replace(/%2B/gi, '+');
    }

    /**
     * This method is intended for encoding *key* or *value* parts of query component. We need a custom
     * method because encodeURIComponent is too aggressive and encodes stuff that doesn't have to be
     * encoded per http://tools.ietf.org/html/rfc3986:
     *    query       = *( pchar / "/" / "?" )
     *    pchar         = unreserved / pct-encoded / sub-delims / ":" / "@"
     *    unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
     *    pct-encoded   = "%" HEXDIG HEXDIG
     *    sub-delims    = "!" / "$" / "&" / "'" / "(" / ")"
     *                     / "*" / "+" / "," / ";" / "="
     */
    function encodeUriQuery(val, pctEncodeSpaces) {
      return encodeURIComponent(val).
        replace(/%40/gi, '@').
        replace(/%3A/gi, ':').
        replace(/%24/g, '$').
        replace(/%2C/gi, ',').
        replace(/%20/g, (pctEncodeSpaces ? '%20' : '+'));
    }

    function Route(template, defaults) {
      this.template = template = template + '#';
      this.defaults = defaults || {};
      this.urlParams = {};
    }

    Route.prototype = {
      setUrlParams: function(config, params, actionUrl) {
        var self = this,
            url = actionUrl || self.template,
            val,
            encodedVal;

        var urlParams = self.urlParams = {};
        forEach(url.split(/\W/), function(param){
          if (!(new RegExp("^\\d+$").test(param)) && param && (new RegExp("(^|[^\\\\]):" + param + "(\\W|$)").test(url))) {
              urlParams[param] = true;
          }
        });
        url = url.replace(/\\:/g, ':');

        params = params || {};
        forEach(self.urlParams, function(_, urlParam){
          val = params.hasOwnProperty(urlParam) ? params[urlParam] : self.defaults[urlParam];
          if (angular.isDefined(val) && val !== null) {
            encodedVal = encodeUriSegment(val);
            url = url.replace(new RegExp(":" + urlParam + "(\\W|$)", "g"), encodedVal + "$1");
          } else {
            url = url.replace(new RegExp("(\/?):" + urlParam + "(\\W|$)", "g"), function(match,
                leadingSlashes, tail) {
              if (tail.charAt(0) == '/') {
                return tail;
              } else {
                return leadingSlashes + tail;
              }
            });
          }
        });

        // set the url
        config.url = url.replace(/#$/, '');

        // set params - delegate param encoding to $http
        forEach(params, function(value, key){
          if (!self.urlParams[key]) {
            config.params = config.params || {};
            config.params[key] = value;
          }
        });
      }
    };


    function djrResourceFactory(url, paramDefaults, actions) {
      var route = new Route(url);

      actions = extend({}, DEFAULT_ACTIONS, actions);

      function extractParams(data, actionParams){
        var ids = {};
        actionParams = extend({}, paramDefaults, actionParams);
        forEach(actionParams, function(value, key){
          if (isFunction(value)) { value = value(); }
          ids[key] = value.charAt && value.charAt(0) == '@' ? getter(data, value.substr(1)) : value;
        });
        return ids;
      }

      function DjangoRESTResource(value){
        copy(value || {}, this);
      }

      forEach(actions, function(action, name) {
        action.method = angular.uppercase(action.method);
        var hasBody = action.method == 'POST' || action.method == 'PUT' || action.method == 'PATCH';
        DjangoRESTResource[name] = function(a1, a2, a3, a4) {
          var params = {};
          var data;
          var success = noop;
          var error = null;
          var promise;

          switch(arguments.length) {
          case 4:
            error = a4;
            success = a3;
            //break;
            //fallthrough
          case 3:
          case 2:
            if (isFunction(a2)) {
              if (isFunction(a1)) {
                success = a1;
                error = a2;
                break;
              }

              success = a2;
              error = a3;
              //fallthrough
            } else {
              params = a1;
              data = a2;
              success = a3;
              break;
            }
          case 1:
            if (isFunction(a1)) success = a1;
            else if (hasBody) data = a1;
            else params = a1;
            break;
          case 0: break;
          default:
            throw "Expected between 0-4 arguments [params, data, success, error], got " +
              arguments.length + " arguments.";
          }

          var value = this instanceof DjangoRESTResource ? this : (action.isArray ? [] : new DjangoRESTResource(data));
          var httpConfig = {},
              promise;

          forEach(action, function(value, key) {
            if (key == 'method' && action.hasOwnProperty('method_if_field_has_value')) {
              // Check if the action's HTTP method is dependent on a field holding a value ('id' for example)
              var field = action.method_if_field_has_value[0];
              var fieldDependentMethod = action.method_if_field_has_value[1];
              httpConfig.method =
                (data.hasOwnProperty(field) && data[field] !== null) ? fieldDependentMethod : action.method;
            } else if (key != 'params' && key != 'isArray' ) {
              httpConfig[key] = copy(value);
            }
          });
          httpConfig.data = data;
          route.setUrlParams(httpConfig, extend({}, extractParams(data, action.params || {}), params), action.url);

          function markResolved() { value.$resolved = true; }

          promise = $http(httpConfig);
          value.$resolved = false;

          promise.then(markResolved, markResolved);
          value.$then = promise.then(function(response) {
            // Success wrapper

            var data = response.data;
            var then = value.$then, resolved = value.$resolved;

            var deferSuccess = false;

            if (data) {
              if (action.isArray) {
                value.length = 0;

                // If it's an object with count and results, it's a pagination container, not an array:
                if (data.hasOwnProperty("count") && data.hasOwnProperty("results")) {
                  // Don't call success callback until the last page has been accepted:
                  deferSuccess = true;

                  var paginator = function recursivePaginator(data) {
                    // If there is a next page, go ahead and request it before parsing our results. Less wasted time.
                    if (data.next !== null) {
                      var next_config = copy(httpConfig);
                      next_config.params = {};
                      next_config.url = data.next;
                      $http(next_config).success(function(next_data) { recursivePaginator(next_data); }).error(error);
                    }
                    // Ok, now load this page's results:
                    forEach(data.results, function(item) {
                      value.push(new DjangoRESTResource(item));
                    });
                    if (data.next == null) {
                      // We've reached the last page, call the original success callback with the concatenated pages of data.
                      (success||noop)(value, response.headers);
                    }
                  };
                  paginator(data);
                } else {
                  //Not paginated, push into array as normal.
                  forEach(data, function(item) {
                    value.push(new DjangoRESTResource(item));
                  });
                }
              } else {
                // Not an isArray action
                copy(data, value);

                // Copy operation destroys value's original properties, so restore some of the old ones:
                value.$then = then;
                value.$resolved = resolved;
                value.$promise = promise;
              }
            }

            if (!deferSuccess) {
              (success||noop)(value, response.headers);
            }

            response.resource = value;
            return response;
          }, error).then;

          return value;
        };


        DjangoRESTResource.prototype['$' + name] = function(a1, a2, a3) {
          var params = extractParams(this),
              success = noop,
              error;

          switch(arguments.length) {
          case 3: params = a1; success = a2; error = a3; break;
          case 2:
          case 1:
            if (isFunction(a1)) {
              success = a1;
              error = a2;
            } else {
              params = a1;
              success = a2 || noop;
            }
          case 0: break;
          default:
            throw "Expected between 1-3 arguments [params, success, error], got " +
              arguments.length + " arguments.";
          }
          var data = hasBody ? this : undefined;
          return DjangoRESTResource[name].call(this, params, data, success, error);
        };
      });

      DjangoRESTResource.bind = function(additionalParamDefaults){
        return djrResourceFactory(url, extend({}, paramDefaults, additionalParamDefaults), actions);
      };

      return DjangoRESTResource;
    }

    return djrResourceFactory;
  }]);
