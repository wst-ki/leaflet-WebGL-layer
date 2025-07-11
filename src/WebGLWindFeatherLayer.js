/**
 * WebGL Wind Barb Layer for Leaflet - Standard Compliant Version
 *
 * This module provides a Leaflet layer to render wind barbs using WebGL
 * for high performance. It correctly handles wind speed in meters per second (m/s),
 * converts it to knots, and draws meteorologically accurate wind barb symbols.
 *
 * Key Features:
 * - Dynamically adjusts barb density based on map zoom level.
 * - Dynamically adjusts barb size based on map zoom level.
 * - Converts m/s to knots for symbol representation.
 * - Draws standard wind barb symbols (5/10/50 knots).
 */
export function createWebGLWindFeatherLayer(leaflet) {
    
    const WebGLWindFeatherLayer = leaflet.Layer.extend({
        includes: leaflet.Mixin.Events,
        options: {
            oceanData: null,
            zIndex: 20,
            color: null,
            colorProperty: 'direction',
        },

        setOceanData: function(oceanData) {
            this.options.oceanData = oceanData;
            if (this._map) {
                this._resetAndDraw();
            }
        },
        setZIndex: function(zIndex) {
            this.options.zIndex = zIndex;
            if (this._container) {
                this._container.style.zIndex = zIndex;
            }
            return this;
        },

        getZIndex: function() {
            return this.options.zIndex;
        },
        // -----------------------------------------------------------------
        //  Core Leaflet Layer Methods (Unchanged)
        // -----------------------------------------------------------------

        onAdd: function(map) {
            this._map = map;
            if (!this._container) {
                this._initCanvas();
            }
            map.getPanes().overlayPane.appendChild(this._container);

            map.on("zoomstart", this._clearCanvas, this);
            map.on("moveend", this._resetAndDraw, this);
            if (map.options.zoomAnimation && leaflet.Browser.any3d) {
                map.on("zoomanim", this._animateZoom, this);
            }
            
            this._resetAndDraw();
        },

        onRemove: function(map) {
            map.getPanes().overlayPane.removeChild(this._container);
            map.off("zoomstart", this._clearCanvas, this);
            map.off("moveend", this._resetAndDraw, this);
            if (map.options.zoomAnimation) {
                map.off("zoomanim", this._animateZoom, this);
            }
            this._cleanupWebGL();
            this._container = null;
            this._canvas = null;
        },

        // -----------------------------------------------------------------
        //  Canvas and WebGL Initialization
        // -----------------------------------------------------------------

        _initCanvas: function() {
            const container = leaflet.DomUtil.create('div', 'leaflet-wind-feather-layer');
            const canvas = leaflet.DomUtil.create('canvas', '', container);
            container.style.position = 'absolute';
            container.style.top = '0';
            container.style.left = '0';
            container.style.pointerEvents = 'none';
            container.style.zIndex = this.options.zIndex;
            this._container = container;
            this._canvas = canvas;
        },

        _resetAndDraw: function() {
            if (!this._map) return;
            const canvas = this._canvas;
            const mapSize = this._map.getSize();
            const containerPoint = this._map.containerPointToLayerPoint([0, 0]);

            leaflet.DomUtil.setPosition(this._container, containerPoint);
            this._container.style.width = mapSize.x + "px";
            this._container.style.height = mapSize.y + "px";
            canvas.width = mapSize.x;
            canvas.height = mapSize.y;
            
            if (!this.gl) {
                if (!this._initWebGL()) {
                    console.error("WebGL initialization failed. Layer will not work.");
                    return;
                }
            } else {
                this._drawWindFeathers();
            }
            this._drawWindFeathers();
        },
        
        _initWebGL: function() {
            this.gl = this._canvas.getContext('webgl');
            if (!this.gl) {
                console.error('WebGL not supported!');
                return false;
            }
            const gl = this.gl;

            const vertexShaderSource = `attribute vec2 a_position;attribute vec2 a_texCoord;attribute vec2 a_offset;attribute float a_rotation;attribute vec3 a_color;uniform vec2 u_resolution;uniform float u_scale;varying vec2 v_texCoord;varying vec3 v_color;void main(){float c=cos(a_rotation),s=sin(a_rotation);vec2 r=vec2(a_position.x*c-a_position.y*s,a_position.x*s+a_position.y*c);vec2 p=(r*u_scale/64.0)+a_offset;vec2 cs=((p/u_resolution)*2.0)-1.0;gl_Position=vec4(cs*vec2(1,-1),0,1);v_texCoord=a_texCoord;v_color=a_color;}`;
            const fragmentShaderSource = `precision mediump float;uniform sampler2D u_texture;varying vec2 v_texCoord;varying vec3 v_color;void main(){vec4 tc=texture2D(u_texture,v_texCoord);if(tc.a<0.1)discard;gl_FragColor=vec4(v_color,tc.a);}`;

            this.program = this._createShaderProgram(gl, vertexShaderSource, fragmentShaderSource);
            if (!this.program) return false;

            this.attribLocations = {
                position: gl.getAttribLocation(this.program, 'a_position'),
                texCoord: gl.getAttribLocation(this.program, 'a_texCoord'),
                offset: gl.getAttribLocation(this.program, 'a_offset'),
                rotation: gl.getAttribLocation(this.program, 'a_rotation'),
                color: gl.getAttribLocation(this.program, 'a_color')
            };
            this.uniformLocations = {
                resolution: gl.getUniformLocation(this.program, 'u_resolution'),
                scale: gl.getUniformLocation(this.program, 'u_scale'),
                texture: gl.getUniformLocation(this.program, 'u_texture')
            };

            this.windTextures = {};
            
            return true;
        },

        _cleanupWebGL: function() {
            if (this.gl) {
                if (this.program) this.gl.deleteProgram(this.program);
                if (this.windTextures) {
                    Object.values(this.windTextures).forEach(texture => {
                        if (texture) this.gl.deleteTexture(texture);
                    });
                }
                this.program = null;
                this.windTextures = {};
                this.gl = null;
            }
        },

        // -----------------------------------------------------------------
        //  Texture and Drawing Logic
        // -----------------------------------------------------------------

        _createWindBarbTexture: function(gl, knots) {
            const canvas = document.createElement('canvas');
            const size = 64;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.fillStyle = 'white';

            const cx = size / 2;
            const staffHeight = 56;
            const barbLength = 28;

            const staffTopY = (size - staffHeight) / 2;
            const staffBottomY = staffTopY + staffHeight;

            if (knots < 3) {
                ctx.beginPath();
                ctx.arc(cx, size / 2, 6, 0, 2 * Math.PI);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.moveTo(cx, staffTopY);
                ctx.lineTo(cx, staffBottomY);
                ctx.stroke();
            }

            let remainingKnots = knots;
            let yPos = staffTopY;
            const barbSpacing = 7;
            const barbAngle = Math.PI / 12;

            while (remainingKnots >= 48) {
                ctx.beginPath();
                ctx.moveTo(cx, yPos);
                ctx.lineTo(cx - barbLength, yPos + barbSpacing / 2);
                ctx.lineTo(cx, yPos + barbSpacing);
                ctx.closePath();
                ctx.fill();
                yPos += barbSpacing + 4;
                remainingKnots -= 50;
            }
            while (remainingKnots >= 8) {
                ctx.beginPath();
                ctx.moveTo(cx, yPos);
                ctx.lineTo(cx - barbLength * Math.cos(barbAngle), yPos + barbLength * Math.sin(barbAngle));
                ctx.stroke();
                yPos += barbSpacing;
                remainingKnots -= 10;
            }
            if (remainingKnots >= 3) {
                const shortBarbLength = barbLength * 0.5;
                ctx.beginPath();
                ctx.moveTo(cx, yPos);
                ctx.lineTo(cx - shortBarbLength * Math.cos(barbAngle), yPos + shortBarbLength * Math.sin(barbAngle));
                ctx.stroke();
            }

            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.bindTexture(gl.TEXTURE_2D, null);
            return texture;
        },

        _drawWindFeathers: function() {
            if (!this.gl || !this.program || !this.options.oceanData) {
                this._clearCanvas(); return;
            }
            const uData = this.options.oceanData.data[0];
            const vData = this.options.oceanData.data[1];
            if (!uData || !vData) {
                this._clearCanvas(); return;
            }
            const windFeathers = this._collectWindFeatherData(this._map, uData, vData);
            if (windFeathers.length === 0) {
                this._clearCanvas(); return;
            }

            const gl = this.gl;
            const canvas = this._canvas;
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(this.program);
            gl.uniform2f(this.uniformLocations.resolution, canvas.width, canvas.height);

            // [关键修改 1] 动态计算风向杆的大小
            const mapZoom = this._map.getZoom();
            // 一个简单的公式：基础大小15px，每放大一级增加4px
            const dynamicBarbSize = 15 + (mapZoom * 2.5); 
            gl.uniform1f(this.uniformLocations.scale, dynamicBarbSize);

            const feathersByKnots = {};
            windFeathers.forEach(feather => {
                if (!feathersByKnots[feather.knots]) feathersByKnots[feather.knots] = [];
                feathersByKnots[feather.knots].push(feather);
            });

            Object.keys(feathersByKnots).forEach(knotsStr => {
                const knots = parseInt(knotsStr, 10);
                if (!this.windTextures[knots]) {
                    this.windTextures[knots] = this._createWindBarbTexture(gl, knots);
                }
                this._drawFeatherBatch(gl, feathersByKnots[knots], this.windTextures[knots]);
            });
        },

        _drawFeatherBatch: function(gl, feathers, texture) {
            if (feathers.length === 0 || !texture) return;
            
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(this.uniformLocations.texture, 0);

            const floatsPerVertex = 10;
            const verticesPerFeather = 4;
            const vertexData = new Float32Array(feathers.length * verticesPerFeather * floatsPerVertex);
            const indices = new Uint16Array(feathers.length * 6);
            const halfSize = 32.0;
            const quadVertices = [ -halfSize, -halfSize, 0.0, 0.0, halfSize, -halfSize, 1.0, 0.0, halfSize,  halfSize, 1.0, 1.0, -halfSize,  halfSize, 0.0, 1.0 ];

            feathers.forEach((feather, i) => {
                const baseVertexIndex = i * verticesPerFeather;
                const baseFloatIndex = baseVertexIndex * floatsPerVertex;
                const rotation = feather.angle * Math.PI / 180.0;
                const c = feather.color;
                for (let j = 0; j < verticesPerFeather; j++) {
                    const currentFloatIndex = baseFloatIndex + j * floatsPerVertex;
                    const quadBaseIndex = j * 4;
                    vertexData[currentFloatIndex] = quadVertices[quadBaseIndex];
                    vertexData[currentFloatIndex + 1] = quadVertices[quadBaseIndex + 1];
                    vertexData[currentFloatIndex + 2] = quadVertices[quadBaseIndex + 2];
                    vertexData[currentFloatIndex + 3] = quadVertices[quadBaseIndex + 3];
                    vertexData[currentFloatIndex + 4] = feather.x;
                    vertexData[currentFloatIndex + 5] = feather.y;
                    vertexData[currentFloatIndex + 6] = rotation;
                    vertexData[currentFloatIndex + 7] = c.r / 255.0;
                    vertexData[currentFloatIndex + 8] = c.g / 255.0;
                    vertexData[currentFloatIndex + 9] = c.b / 255.0;
                }
                const baseIndex = i * 6;
                indices[baseIndex] = baseVertexIndex;
                indices[baseIndex + 1] = baseVertexIndex + 1;
                indices[baseIndex + 2] = baseVertexIndex + 2;
                indices[baseIndex + 3] = baseVertexIndex;
                indices[baseIndex + 4] = baseVertexIndex + 2;
                indices[baseIndex + 5] = baseVertexIndex + 3;
            });

            const vertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);
            const indexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

            const stride = floatsPerVertex * 4;
            const attribs = this.attribLocations;
            gl.enableVertexAttribArray(attribs.position);
            gl.vertexAttribPointer(attribs.position, 2, gl.FLOAT, false, stride, 0);
            gl.enableVertexAttribArray(attribs.texCoord);
            gl.vertexAttribPointer(attribs.texCoord, 2, gl.FLOAT, false, stride, 8);
            gl.enableVertexAttribArray(attribs.offset);
            gl.vertexAttribPointer(attribs.offset, 2, gl.FLOAT, false, stride, 16);
            gl.enableVertexAttribArray(attribs.rotation);
            gl.vertexAttribPointer(attribs.rotation, 1, gl.FLOAT, false, stride, 24);
            gl.enableVertexAttribArray(attribs.color);
            gl.vertexAttribPointer(attribs.color, 3, gl.FLOAT, false, stride, 28);

            gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
            gl.deleteBuffer(vertexBuffer);
            gl.deleteBuffer(indexBuffer);
        },
        
        // -----------------------------------------------------------------
        //  Helper Functions
        // -----------------------------------------------------------------
        
        _collectWindFeatherData: function(map, uData, vData) {
            const windFeathers = [];
            const bounds = map.getBounds();
            const mapZoom = map.getZoom();
            
            // [关键修改 2] 动态计算采样密度
            // 这个公式确保了地图缩小时，风向杆数量会减少
            const DENSITY = Math.floor(Math.pow(2, Math.max(0, 9 - mapZoom)));
            
            const uHeader = this.options.oceanData.header[0];
            const lonMin = uHeader.lo1, lonMax = uHeader.lo2, latMin = uHeader.la2, latMax = uHeader.la1;
            
            const nx = uHeader.nx, ny = uHeader.ny;
            const lonStep = (lonMax - lonMin) / (nx - 1), latStep = (latMax - latMin) / (ny - 1);
            
            for (let j = 0; j < ny; j += DENSITY) {
                for (let i = 0; i < nx; i += DENSITY) {
                    const lat = latMax - j * latStep;
                    const lon = lonMin + i * lonStep;
                    if (lat < bounds.getSouth() || lat > bounds.getNorth() || lon < bounds.getWest() || lon > bounds.getEast()) continue;
                    
                    const u = uData[j][i], v = vData[j][i];
                    if (u === null || v === null) continue;

                    const screenPoint = map.latLngToContainerPoint([lat, lon]);
                    const windVector = this._calculateWindVector(u, v);
                    
                    const knots = this._getRoundedKnots(windVector.speed);
                    
                    const color = this._getWindDirectionColor(windVector.angle);
                    windFeathers.push({ x: screenPoint.x, y: screenPoint.y, angle: windVector.angle, knots: knots, color: color });
                }
            }
            return windFeathers;
        },

        _calculateWindVector: function(u, v) { const speed = Math.sqrt(u * u + v * v); const angle = (270 - Math.atan2(v, u) * 180 / Math.PI) % 360; return { speed, angle }; },

        _getRoundedKnots: function(speedInMs) {
            const knots = speedInMs * 1.94384;
            if (knots < 3) return 0;
            return Math.round(knots / 5) * 5; 
        },

        _getWindDirectionColor: function(angle) { const hue = (600 - angle) % 360; return this._hslToRgb(hue, 80, 60); },
        _hslToRgb: function(h, s, l) { s /= 100; l /= 100; const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2; let r = 0, g = 0, b = 0; if (h >= 0 && h < 60) { r = c; g = x; b = 0; } else if (h >= 60 && h < 120) { r = x; g = c; b = 0; } else if (h >= 120 && h < 180) { r = 0; g = c; b = x; } else if (h >= 180 && h < 240) { r = 0; g = x; b = c; } else if (h >= 240 && h < 300) { r = x; g = 0; b = c; } else if (300 <= h && h < 360) { r = c; g = 0; b = x; } return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }; },
        _clearCanvas: function() { if (this.gl) { this.gl.clear(this.gl.COLOR_BUFFER_BIT); } },
        _animateZoom: function(e) { if (!this._container) return; const scale = this._map.getZoomScale(e.zoom); const offset = this._map._getCenterOffset(e.center)._multiplyBy(-scale).subtract(this._map._getMapPanePos()); leaflet.DomUtil.setTransform(this._container, offset, scale); },
        _createShader: function(gl, type, source) { const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { console.error('Shader compile error:', gl.getShaderInfoLog(shader)); gl.deleteShader(shader); return null; } return shader; },
        _createShaderProgram: function(gl, vertexSource, fragmentSource) { const vertexShader = this._createShader(gl, gl.VERTEX_SHADER, vertexSource); const fragmentShader = this._createShader(gl, gl.FRAGMENT_SHADER, fragmentSource); if (!vertexShader || !fragmentShader) return null; const program = gl.createProgram(); gl.attachShader(program, vertexShader); gl.attachShader(program, fragmentShader); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.error('Shader link error:', gl.getProgramInfoLog(program)); gl.deleteProgram(program); return null; } return program; }
    });

    // Factory function
    leaflet.createWebGLWindFeatherLayer = function(options) {
        return new WebGLWindFeatherLayer(options);
    };
    
    return WebGLWindFeatherLayer;
}
