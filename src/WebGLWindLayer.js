/**
 * WebGLWindLayer.js
 * 修复粒子拖尾闪烁问题和位置绘制问题的版本
 * 新增功能：支持自定义粒子颜色和大小
 * 修复：解决了地图缩放/平移后留下渲染痕迹的问题
 */

// --- GLSL 着色器源码 (无变化) ---

const QUAD_VERTEX_SHADER = `#version 300 es
    in vec2 a_pos;
    out vec2 v_tex_pos;
    void main() {
        v_tex_pos = a_pos;
        gl_Position = vec4(1.0 - 2.0 * a_pos, 0, 1);
    }
`;

const SCREEN_FRAGMENT_SHADER = `#version 300 es
    precision mediump float;
    uniform sampler2D u_screen;
    uniform float u_opacity;
    in vec2 v_tex_pos;
    out vec4 outColor;
    void main() {
        vec4 color = texture(u_screen, v_tex_pos);
        outColor = vec4(color.rgb, color.a * u_opacity);
    }
`;

const DRAW_VERTEX_SHADER = `#version 300 es
    precision mediump float;
    uniform mat3 u_matrix;
    uniform sampler2D u_particles;
    uniform float u_particle_res;
    uniform float u_particle_size;
    in float a_index;
    out vec2 v_particle_pos;
    #define PI 3.141592653589793
    vec2 project(vec2 lonlat) {
        float lon_rad = radians(lonlat.x);
        float lat_rad = radians(lonlat.y);
        return vec2(
            lon_rad,
            log(tan(PI / 4.0 + lat_rad / 2.0))
        );
    }
    void main() {
        vec4 color = texture(u_particles, vec2(
            fract(a_index / u_particle_res),
            floor(a_index / u_particle_res) / u_particle_res
        ));
        v_particle_pos = color.xy;
        vec2 projected_pos = project(v_particle_pos);
        vec3 transformed = u_matrix * vec3(projected_pos, 1.0);
        gl_Position = vec4(transformed.xy, 0.0, 1.0);
        gl_PointSize = u_particle_size;
    }
`;

const DRAW_FRAGMENT_SHADER = `#version 300 es
    precision mediump float;
    uniform sampler2D u_wind;
    uniform vec2 u_wind_min;
    uniform vec2 u_wind_max;
    uniform vec3 u_color1;
    uniform vec3 u_color2;
    uniform float u_is_gradient;
    in vec2 v_particle_pos;
    out vec4 outColor;
    void main() {
        vec2 tex_coord = (v_particle_pos - u_wind_min) / (u_wind_max - u_wind_min);
        if (tex_coord.x < 0.0 || tex_coord.x > 1.0 || tex_coord.y < 0.0 || tex_coord.y > 1.0) {
            discard;
        }
        vec2 wind = texture(u_wind, tex_coord).rg;
        float speed = length(wind);
        float normalized_speed = clamp(speed / 15.0, 0.0, 1.0);
        vec3 final_color;
        if (u_is_gradient > 0.5) {
            final_color = mix(u_color1, u_color2, normalized_speed);
        } else {
            final_color = u_color1;
        }
        outColor = vec4(final_color, 0.8);
    }
`;

const UPDATE_FRAGMENT_SHADER = `#version 300 es
    precision highp float;
    uniform sampler2D u_particles;
    uniform sampler2D u_wind;
    uniform vec2 u_wind_min;
    uniform vec2 u_wind_max;
    uniform float u_speed_factor;
    uniform float u_drop_rate;
    uniform float u_rand_seed;
    in vec2 v_tex_pos;
    out vec4 outColor;
    float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453 + u_rand_seed);
    }
    void main() {
        vec4 state = texture(u_particles, v_tex_pos);
        vec2 pos = state.xy;
        vec2 tex_coord = (pos - u_wind_min) / (u_wind_max - u_wind_min);
        if (tex_coord.x < 0.0 || tex_coord.x > 1.0 || tex_coord.y < 0.0 || tex_coord.y > 1.0 || rand(v_tex_pos) < u_drop_rate) {
            pos = vec2(
                u_wind_min.x + rand(v_tex_pos) * (u_wind_max.x - u_wind_min.x),
                u_wind_min.y + rand(v_tex_pos + 0.1) * (u_wind_max.y - u_wind_min.y)
            );
        } else {
            vec2 wind = texture(u_wind, tex_coord).rg;
            float lat_rad = radians(pos.y);
            pos.x += wind.x * u_speed_factor / cos(lat_rad);
            pos.y += wind.y * u_speed_factor;
        }
        outColor = vec4(pos, 0.0, 1.0);
    }
`;

/**
 * 注册 WebGLWindLayer 插件
 * @param {object} L - Leaflet 主对象
 */
export function registerWebGLWindLayer(L) {
    const WebGLWindLayer = L.Layer.extend({
        options: {
            particleCount: 32768,
            speedFactor: 0.8,
            dropRate: 0.003,
            fadeOpacity: 0.96,
            particleSize: 2.0,
            zIndex: 1,
            color: ['#00FFFF', '#FF0000']
        },

        initialize: function(windData, options) {
            L.setOptions(this, options);
            this._windData = windData;
            this._programs = {};
            this._textures = {};
            this._buffers = {};
            this._framebuffers = {};
            this._matrix = new Float32Array(9);
            this._processColorOption();
        },

        onAdd: function(map) {
            this._map = map;
            this._canvas = L.DomUtil.create('canvas', 'leaflet-wind-layer leaflet-layer');
            if (this.options.zIndex !== undefined) {
                this._canvas.style.zIndex = this.options.zIndex;
            }
            const targetPane = this.options.pane ? map.getPane(this.options.pane) : map.getPanes().overlayPane;
            targetPane.appendChild(this._canvas);

            const gl = this._canvas.getContext('webgl2', { 
                antialias: false,
                alpha: true,
                preserveDrawingBuffer: false
            });
            
            if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
                throw new Error('WebGL 2 or required extensions not supported');
            }
            
            this._gl = gl;
            this._initGL();
            this._resize();
            
            map.on('moveend', this._update, this);
            map.on('zoomend', this._update, this);  
            map.on('resize', this._resize, this);
            map.on('move', this._updateMatrix, this);
            
            this._frame();
        },

        onRemove: function(map) {
            if (this._canvas && this._canvas.parentNode) {
                this._canvas.parentNode.removeChild(this._canvas);
            }
            map.off('moveend', this._update, this);
            map.off('zoomend', this._update, this);
            map.off('resize', this._resize, this);
            map.off('move', this._updateMatrix, this);
            
            if (this._animationFrame) {
                cancelAnimationFrame(this._animationFrame);
            }
        },

        setColor: function(color) {
            this.options.color = color;
            this._processColorOption();
            return this;
        },

        setParticleSize: function(size) {
            this.options.particleSize = size;
            return this;
        },
        setZIndex: function(zIndex) {
            this.options.zIndex = zIndex;
            if (this._canvas) {
                this._canvas.style.zIndex = zIndex;
            }
            return this;
        },

        getZIndex: function() {
            return this.options.zIndex;
        },

        _initGL: function() {
            const gl = this._gl;
            this._programs.draw = this._createProgram(DRAW_VERTEX_SHADER, DRAW_FRAGMENT_SHADER);
            this._programs.update = this._createProgram(QUAD_VERTEX_SHADER, UPDATE_FRAGMENT_SHADER);
            this._programs.screen = this._createProgram(QUAD_VERTEX_SHADER, SCREEN_FRAGMENT_SHADER);

            this._buffers.quad = this._createBuffer(new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]));
            this._createWindTexture();
            this._createParticleTextures();
            this._createParticleIndexBuffer();
            this._createFramebuffers();
            this._createScreenFramebuffer();
        },
        
        _drawParticles: function() {
            const gl = this._gl;
            const program = this._programs.draw;
            
            gl.useProgram(program.program);
            
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            this._bindAttribute(this._buffers.particleIndex, program.a_index, 1);
            
            this._bindTexture(this._textures.particles1, 0);
            this._bindTexture(this._textures.wind, 1);
            
            gl.uniform1i(program.u_particles, 0);
            gl.uniform1i(program.u_wind, 1);
            
            const [minLon, minLat, maxLon, maxLat] = this._windData.bounds;
            gl.uniform2f(program.u_wind_min, minLon, minLat);
            gl.uniform2f(program.u_wind_max, maxLon, maxLat);
            gl.uniform1f(program.u_particle_res, this._particleStateResolution);
            
            this._updateMatrix();
            gl.uniformMatrix3fv(program.u_matrix, false, this._matrix);

            gl.uniform1f(program.u_particle_size, this.options.particleSize);
            gl.uniform3fv(program.u_color1, this._color1);
            gl.uniform3fv(program.u_color2, this._color2);
            gl.uniform1f(program.u_is_gradient, this._isGradient ? 1.0 : 0.0);
            
            gl.drawArrays(gl.POINTS, 0, this._particleStateResolution * this._particleStateResolution);
            gl.disable(gl.BLEND);
        },
        
        _processColorOption: function() {
            function hexToRgb(hex) {
                if (hex.startsWith('#')) hex = hex.substring(1);
                const bigint = parseInt(hex, 16);
                const r = (bigint >> 16) & 255;
                const g = (bigint >> 8) & 255;
                const b = bigint & 255;
                return [r / 255, g / 255, b / 255];
            }

            const colorOpt = this.options.color;
            if (typeof colorOpt === 'string') {
                this._isGradient = false;
                this._color1 = hexToRgb(colorOpt);
                this._color2 = [0, 0, 0];
            } else if (Array.isArray(colorOpt)) {
                if (colorOpt.length === 1) {
                    this._isGradient = false;
                    this._color1 = hexToRgb(colorOpt[0]);
                    this._color2 = [0, 0, 0];
                } else if (colorOpt.length >= 2) {
                    this._isGradient = true;
                    this._color1 = hexToRgb(colorOpt[0]);
                    this._color2 = hexToRgb(colorOpt[1]);
                }
            } else {
                this._isGradient = true;
                this._color1 = [0.0, 1.0, 1.0];
                this._color2 = [1.0, 0.0, 0.0];
            }
        },
        
        _project: function(lat, lon) {
            const d = Math.PI / 180;
            const lat_rad = lat * d;
            const lon_rad = lon * d;
            const y = Math.log(Math.tan((Math.PI / 4) + (lat_rad / 2)));
            return [lon_rad, y];
        },

        _draw: function() {
            const gl = this._gl;
            if (!gl) return;
            
            this._updateParticles();
            this._drawScreen();
            this._swapParticleTextures();
        },

        _drawScreen: function() {
            const gl = this._gl;
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffers.temp);
            gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            
            this._drawTexture(this._textures.screen, this.options.fadeOpacity);
            this._drawParticles();
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffers.screen);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this._drawTexture(this._textures.temp, 1.0);
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            this._drawTexture(this._textures.screen, 1.0);
            gl.disable(gl.BLEND);
        },

        _drawTexture: function(texture, opacity) {
            const gl = this._gl;
            const program = this._programs.screen;
            gl.useProgram(program.program);

            this._bindAttribute(this._buffers.quad, program.a_pos, 2);
            this._bindTexture(texture, 0);
            gl.uniform1i(program.u_screen, 0);
            gl.uniform1f(program.u_opacity, opacity);

            gl.drawArrays(gl.TRIANGLES, 0, 6);
        },

        _swapParticleTextures: function() {
            [this._textures.particles0, this._textures.particles1] = [this._textures.particles1, this._textures.particles0];
            [this._framebuffers.particles0, this._framebuffers.particles1] = [this._framebuffers.particles1, this._framebuffers.particles0];
        },
        
        _resize: function() {
            const canvas = this._canvas;
            const mapSize = this._map.getSize();
            
            if (canvas.width !== mapSize.x || canvas.height !== mapSize.y) {
                canvas.width = mapSize.x;
                canvas.height = mapSize.y;
                this._createScreenFramebuffer();
            }
            
            this._gl.viewport(0, 0, canvas.width, canvas.height);
            
            const pos = this._map.containerPointToLayerPoint([0, 0]);
            L.DomUtil.setPosition(this._canvas, pos);
        },

        _createScreenFramebuffer: function() {
            const gl = this._gl;
            const emptyPixels = new Uint8Array(gl.canvas.width * gl.canvas.height * 4);
            
            if (this._textures.screen) gl.deleteTexture(this._textures.screen);
            if (this._textures.temp) gl.deleteTexture(this._textures.temp);
            if (this._framebuffers.screen) gl.deleteFramebuffer(this._framebuffers.screen);
            if (this._framebuffers.temp) gl.deleteFramebuffer(this._framebuffers.temp);
            
            this._textures.screen = this._createTexture(gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gl.canvas.width, gl.canvas.height, emptyPixels);
            this._textures.temp = this._createTexture(gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gl.canvas.width, gl.canvas.height, emptyPixels);
            
            this._framebuffers.screen = this._createFramebuffer(this._textures.screen);
            this._framebuffers.temp = this._createFramebuffer(this._textures.temp);
        },
        
        _createWindTexture: function() {
            const gl = this._gl;
            const { u, v, width, height } = this._windData;
            const windFloats = new Float32Array(u.length * 2);
            
            for (let j = 0; j < height; j++) {
                for (let i = 0; i < width; i++) {
                    const sourceIndex = j * width + i;
                    const targetRow = height - 1 - j;
                    const targetIndex = targetRow * width + i;
                    windFloats[targetIndex * 2] = u[sourceIndex];
                    windFloats[targetIndex * 2 + 1] = v[sourceIndex];
                }
            }
            
            this._textures.wind = this._createTexture(
                gl.RG32F, gl.RG, gl.FLOAT, 
                width, height, 
                windFloats
            );
        },

        _createParticleTextures: function() {
            const gl = this._gl;
            const particleRes = Math.ceil(Math.sqrt(this.options.particleCount));
            this._particleStateResolution = particleRes;
            
            const particleState = new Float32Array(particleRes * particleRes * 4);
            const [minLon, minLat, maxLon, maxLat] = this._windData.bounds;
            
            for (let i = 0; i < particleState.length; i += 4) {
                particleState[i] = minLon + Math.random() * (maxLon - minLon);
                particleState[i + 1] = minLat + Math.random() * (maxLat - minLat);
                particleState[i + 2] = 0.0;
                particleState[i + 3] = 1.0;
            }
            
            this._textures.particles0 = this._createTexture(
                gl.RGBA32F, gl.RGBA, gl.FLOAT, 
                particleRes, particleRes, 
                particleState
            );
            
            this._textures.particles1 = this._createTexture(
                gl.RGBA32F, gl.RGBA, gl.FLOAT, 
                particleRes, particleRes, 
                null
            );
        },

        _createParticleIndexBuffer: function() {
            const particleRes = this._particleStateResolution;
            const particleIndices = new Float32Array(particleRes * particleRes);
            for (let i = 0; i < particleIndices.length; i++) {
                particleIndices[i] = i;
            }
            this._buffers.particleIndex = this._createBuffer(particleIndices);
        },

        _createFramebuffers: function() {
            this._framebuffers.particles0 = this._createFramebuffer(this._textures.particles0);
            this._framebuffers.particles1 = this._createFramebuffer(this._textures.particles1);
        },

        _updateParticles: function() {
            const gl = this._gl;
            const program = this._programs.update;
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffers.particles1);
            gl.viewport(0, 0, this._particleStateResolution, this._particleStateResolution);
            
            gl.useProgram(program.program);
            this._bindAttribute(this._buffers.quad, program.a_pos, 2);
            
            this._bindTexture(this._textures.particles0, 0);
            this._bindTexture(this._textures.wind, 1);
            
            gl.uniform1i(program.u_particles, 0);
            gl.uniform1i(program.u_wind, 1);
            
            const [minLon, minLat, maxLon, maxLat] = this._windData.bounds;
            gl.uniform2f(program.u_wind_min, minLon, minLat);
            gl.uniform2f(program.u_wind_max, maxLon, maxLat);
            gl.uniform1f(program.u_speed_factor, this.options.speedFactor * 0.01);
            gl.uniform1f(program.u_drop_rate, this.options.dropRate);
            gl.uniform1f(program.u_rand_seed, Math.random());
            
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        },
        
        _frame: function() {
            if (this._map) {
                this._draw();
                this._animationFrame = requestAnimationFrame(this._frame.bind(this));
            }
        },

        _updateMatrix: function() {
            const mapBounds = this._map.getBounds();
            const ne = mapBounds.getNorthEast();
            const sw = mapBounds.getSouthWest();

            const [ne_x, ne_y] = this._project(ne.lat, ne.lng);
            const [sw_x, sw_y] = this._project(sw.lat, sw.lng);

            const scale_x = 2.0 / (ne_x - sw_x);
            const offset_x = -(ne_x + sw_x) / (ne_x - sw_x);

            const scale_y = 2.0 / (ne_y - sw_y);
            const offset_y = -(ne_y + sw_y) / (ne_y - sw_y);

            this._matrix.set([
                scale_x, 0, 0,
                0, scale_y, 0,
                offset_x, offset_y, 1
            ]);
        },

        // ⭐️ 核心修复：修改 _update 函数
        _update: function() {
            this._updateMatrix();
            this._resize();

            // 在地图视图变化结束后，强制清除屏幕缓冲
            if (this._gl) {
                const gl = this._gl;
                gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffers.screen);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);

                gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffers.temp);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            }
        },
        
        _createProgram: function(vertSrc, fragSrc) {
            const gl = this._gl;
            const vertShader = this._createShader(gl.VERTEX_SHADER, vertSrc);
            const fragShader = this._createShader(gl.FRAGMENT_SHADER, fragSrc);
            const program = gl.createProgram();
            
            gl.attachShader(program, vertShader);
            gl.attachShader(program, fragShader);
            gl.linkProgram(program);
            
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
            }
            
            const wrapper = { program };
            const numAttributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
            for (let i = 0; i < numAttributes; i++) {
                const attribute = gl.getActiveAttrib(program, i);
                wrapper[attribute.name] = gl.getAttribLocation(program, attribute.name);
            }
            const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < numUniforms; i++) {
                const uniform = gl.getActiveUniform(program, i);
                wrapper[uniform.name] = gl.getUniformLocation(program, uniform.name);
            }
            return wrapper;
        },

        _createShader: function(type, source) {
            const gl = this._gl;
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error('Shader compile error: ' + gl.getShaderInfoLog(shader));
            }
            return shader;
        },

        _createBuffer: function(data) {
            const gl = this._gl;
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
            return buffer;
        },

        _createTexture: function(internalFormat, format, type, width, height, data) {
            const gl = this._gl;
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
            return texture;
        },

        _bindTexture: function(texture, unit) {
            const gl = this._gl;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
        },

        _bindAttribute: function(buffer, attribute, numComponents) {
            const gl = this._gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.vertexAttribPointer(attribute, numComponents, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(attribute);
        },

        _createFramebuffer: function(texture) {
            const gl = this._gl;
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                throw new Error('Framebuffer not complete');
            }
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return fbo;
        }
    });

    L.webGLWindLayer = function(windData, options) {
        return new WebGLWindLayer(windData, options);
    };

    L.WebGLWindLayer = WebGLWindLayer;
}