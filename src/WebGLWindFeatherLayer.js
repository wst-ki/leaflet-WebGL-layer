/**
 * WebGLWindFeatherLayer.js (修复版本)
 * 使用 WebGL 重写的风羽图层，以获得高性能渲染。
 * @param {object} L - Leaflet 主对象
 */
export function createWebGLWindFeatherLayer(L) {

    // --- GLSL 着色器源码 ---

    // 顶点着色器：计算每个风羽的位置、大小和旋转
    const FEATHER_VERTEX_SHADER = `#version 300 es
        precision mediump float;

        // 输入的顶点属性
        in vec2 a_position; // 顶点的经纬度
        in vec2 a_wind_uv;  // 该点的风速 UV 分量

        // 全局变量
        uniform mat3 u_matrix;       // 坐标变换矩阵 (墨卡托投影 -> 裁剪空间)
        uniform float u_scale;       // 风羽的缩放比例
        uniform float u_map_zoom;    // 当前地图缩放级别，用于调整大小

        // 传递给片段着色器的变量
        out float v_angle;
        out float v_speed;

        #define PI 3.141592653589793

        // 墨卡托投影函数
        vec2 project(vec2 lonlat) {
            float lon_rad = radians(lonlat.x);
            float lat_rad = radians(lonlat.y);
            return vec2(
                lon_rad,
                log(tan(PI / 4.0 + lat_rad / 2.0))
            );
        }

        void main() {
            // 计算风速和风向角度
            v_speed = length(a_wind_uv);
            v_angle = atan(a_wind_uv.y, a_wind_uv.x);

            // 如果风速过小，则不显示该点 (通过移出屏幕实现)
            if (v_speed < 0.1) {
                gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                return;
            }

            // 1. 将经纬度投影为墨卡托坐标
            vec2 projected_pos = project(a_position);
            
            // 2. 使用矩阵将墨卡托坐标变换到裁剪空间
            vec3 transformed = u_matrix * vec3(projected_pos, 1.0);
            gl_Position = vec4(transformed.xy, 0.0, 1.0);

            // 3. 设置点精灵的大小，可以根据缩放级别调整
            gl_PointSize = 64.0 * u_scale * pow(2.0, u_map_zoom - 4.0);
        }
    `;

    // 片段着色器：为每个风羽的像素上色
    const FEATHER_FRAGMENT_SHADER = `#version 300 es
        precision mediump float;

        // 从顶点着色器传入的变量
        in float v_angle;
        in float v_speed;

        // 全局变量
        uniform sampler2D u_texture_atlas; // 包含所有风羽图标的纹理图集
        uniform sampler2D u_color_ramp;    // 颜色渐变纹理
        
        // 输出的颜色
        out vec4 outColor;

        #define PI 3.141592653589793

        void main() {
            // --- 1. 计算要从图集中采样的图标索引 ---
            float level;
            if (v_speed >= 0.0 && v_speed <= 2.0) level = 0.0;
            else if (v_speed > 2.0 && v_speed <= 4.0) level = 1.0;
            else if (v_speed > 4.0 && v_speed <= 6.0) level = 2.0;
            else if (v_speed > 6.0 && v_speed <= 8.0) level = 3.0;
            else if (v_speed > 8.0 && v_speed <= 10.0) level = 4.0;
            else if (v_speed > 10.0 && v_speed <= 12.0) level = 5.0;
            else if (v_speed > 12.0 && v_speed <= 14.0) level = 6.0;
            else if (v_speed > 14.0 && v_speed <= 16.0) level = 7.0;
            else if (v_speed > 16.0 && v_speed <= 18.0) level = 8.0;
            else if (v_speed > 18.0 && v_speed <= 20.0) level = 9.0;
            else if (v_speed > 20.0 && v_speed <= 24.0) level = 10.0;
            else if (v_speed > 24.0 && v_speed <= 28.0) level = 11.0;
            else if (v_speed > 28.0 && v_speed <= 32.0) level = 12.0;
            else if (v_speed > 32.0 && v_speed <= 36.0) level = 13.0;
            else level = 14.0;

            // --- 2. 旋转纹理坐标 ---
            vec2 centered_coord = gl_PointCoord - 0.5;
            float angle = v_angle - PI / 2.0;
            mat2 rotation_matrix = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
            vec2 rotated_coord = rotation_matrix * centered_coord + 0.5;

            // --- 3. 计算在纹理图集中的最终坐标 ---
            float col = mod(level, 4.0);
            float row = floor(level / 4.0);
            vec2 atlas_coord = (rotated_coord + vec2(col, row)) / 4.0;

            // --- 4. 采样和上色 ---
            vec4 atlas_color = texture(u_texture_atlas, atlas_coord);
            
            if (atlas_color.a < 0.1 || rotated_coord.x < 0.0 || rotated_coord.x > 1.0 || rotated_coord.y < 0.0 || rotated_coord.y > 1.0) {
                discard;
            }

            vec3 ramp_color = texture(u_color_ramp, vec2(clamp(v_speed / 40.0, 0.0, 1.0), 0.5)).rgb;

            // 使用图标的亮度作为蒙版, 应用颜色渐变的颜色
            float luminance = dot(atlas_color.rgb, vec3(0.2126, 0.7152, 0.0722));
            outColor = vec4(ramp_color, atlas_color.a * luminance);
        }
    `;

    const WebGLWindFeatherLayer = L.Layer.extend({
        options: {
            windDataUV: [],
            zIndex: 20,
            scale: 0.22,
            imageUrls: [
                'https://placehold.co/64x64/ffffff/ffffff?text=1', 'https://placehold.co/64x64/ffffff/ffffff?text=2',
                'https://placehold.co/64x64/ffffff/ffffff?text=3', 'https://placehold.co/64x64/ffffff/ffffff?text=4',
                'https://placehold.co/64x64/ffffff/ffffff?text=5', 'https://placehold.co/64x64/ffffff/ffffff?text=6',
                'https://placehold.co/64x64/ffffff/ffffff?text=7', 'https://placehold.co/64x64/ffffff/ffffff?text=8',
                'https://placehold.co/64x64/ffffff/ffffff?text=9', 'https://placehold.co/64x64/ffffff/ffffff?text=10',
                'https://placehold.co/64x64/ffffff/ffffff?text=11', 'https://placehold.co/64x64/ffffff/ffffff?text=12',
                'https://placehold.co/64x64/ffffff/ffffff?text=13', 'https://placehold.co/64x64/ffffff/ffffff?text=14',
                'https://placehold.co/64x64/ffffff/ffffff?text=15'
            ]
        },

        initialize: function(options) {
            L.setOptions(this, options);
            this._matrix = new Float32Array(9);
            this._gl = null;
            this._program = null;
            this._buffers = {};
            this._textures = {};
            this._uniforms = {};
            this._attributes = {};
            this._point_count = 0;
            this._texturesLoaded = false; // 添加纹理加载状态标志
        },

        onAdd: function(map) {
            this._map = map;
            this._container = L.DomUtil.create('div', 'leaflet-webgl-layer');
            this._canvas = L.DomUtil.create('canvas', '', this._container);
            this._canvas.style.pointerEvents = 'none';
            this._container.style.zIndex = this.options.zIndex;
            
            map.getPanes().overlayPane.appendChild(this._container);

            this._gl = this._canvas.getContext('webgl2', { antialias: true, alpha: true });
            
            if (!this._gl) {
                console.error('WebGL2 not supported');
                return;
            }

            this._initGL();

            map.on('moveend', this._reset, this);
            map.on('zoomend', this._reset, this);
            map.on('resize', this._reset, this);
            
            this._reset();
        },

        onRemove: function(map) {
            if (this._container && this._container.parentNode) {
                map.getPanes().overlayPane.removeChild(this._container);
            }
            map.off('moveend', this._reset, this);
            map.off('zoomend', this._reset, this);
            map.off('resize', this._reset, this);
        },
        
        SetData: function(data) {
            this.options.windDataUV = data;
            if (this._gl) {
                this._createDataBuffers();
                this._reset();
            }
        },

        _initGL: function() {
            const gl = this._gl;
            if (!gl) return;

            const program = this._createProgram(FEATHER_VERTEX_SHADER, FEATHER_FRAGMENT_SHADER);
            if (!program) return;
            this._program = program;

            gl.useProgram(program);
            
            // 获取uniform位置
            this._uniforms.u_matrix = gl.getUniformLocation(program, 'u_matrix');
            this._uniforms.u_scale = gl.getUniformLocation(program, 'u_scale');
            this._uniforms.u_map_zoom = gl.getUniformLocation(program, 'u_map_zoom');
            this._uniforms.u_texture_atlas = gl.getUniformLocation(program, 'u_texture_atlas');
            this._uniforms.u_color_ramp = gl.getUniformLocation(program, 'u_color_ramp');
            
            // 获取attribute位置
            this._attributes.a_position = gl.getAttribLocation(program, 'a_position');
            this._attributes.a_wind_uv = gl.getAttribLocation(program, 'a_wind_uv');

            // 创建纹理
            this._createTextureAtlas();
            this._createColorRampTexture();
            this._createDataBuffers();
        },

        _createDataBuffers: function() {
            const gl = this._gl;
            const data = this.options.windDataUV;
            if (!data || data.length === 0) return;

            const height = data.length;
            const width = data[0].length;
            
            // 修复：使用正确的经纬度范围 (-180 到 180, -90 到 90)
            const bufferData = new Float32Array(width * height * 4);
            let p = 0;
            for (let j = 0; j < height; j++) {
                for (let i = 0; i < width; i++) {
                    const lon = (i / (width - 1)) * 360 - 180; // -180 到 180
                    const lat = 90 - (j / (height - 1)) * 180; // 90 到 -90
                    const wind = data[j][i] || {u: 0, v: 0};
                    
                    bufferData[p++] = lon;
                    bufferData[p++] = lat;
                    bufferData[p++] = wind.u;
                    bufferData[p++] = wind.v;
                }
            }
            this._point_count = width * height;

            if (!this._buffers.data) {
                this._buffers.data = gl.createBuffer();
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this._buffers.data);
            gl.bufferData(gl.ARRAY_BUFFER, bufferData, gl.STATIC_DRAW);

            // 设置顶点属性
            const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
            gl.enableVertexAttribArray(this._attributes.a_position);
            gl.vertexAttribPointer(this._attributes.a_position, 2, gl.FLOAT, false, stride, 0);
            
            gl.enableVertexAttribArray(this._attributes.a_wind_uv);
            gl.vertexAttribPointer(this._attributes.a_wind_uv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
        },

        _createTextureAtlas: function() {
            const gl = this._gl;
            const urls = this.options.imageUrls;

            const promises = urls.map(url => new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => resolve(img);
                img.onerror = (err) => reject(new Error(`Failed to load image: ${url}`));
                img.src = url;
            }));

            Promise.all(promises).then(images => {
                const atlasCanvas = document.createElement('canvas');
                const atlasSize = 256; // 4 * 64px
                atlasCanvas.width = atlasSize;
                atlasCanvas.height = atlasSize;
                const ctx = atlasCanvas.getContext('2d');
                
                // 填充白色背景
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, atlasSize, atlasSize);
                
                images.forEach((img, i) => {
                    const col = i % 4;
                    const row = Math.floor(i / 4);
                    ctx.drawImage(img, col * 64, row * 64, 64, 64);
                });

                this._textures.atlas = this._createTexture(atlasCanvas);
                this._texturesLoaded = true;
                this._draw(); // 纹理加载完成后重新绘制
            }).catch(err => {
                console.error("Failed to create texture atlas:", err);
            });
        },

        _createColorRampTexture: function() {
            const gl = this._gl;
            const canvas = document.createElement('canvas');
            const width = 256;
            const height = 1;
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, width, 0);

            // 风速颜色渐变
            gradient.addColorStop(0 / 40, "rgb(0, 200, 255)");
            gradient.addColorStop(4.5 / 40, "rgb(0, 255, 255)");
            gradient.addColorStop(9 / 40, "rgb(0, 255, 0)");
            gradient.addColorStop(13.5 / 40, "rgb(255, 255, 0)");
            gradient.addColorStop(18 / 40, "rgb(255, 0, 0)");
            gradient.addColorStop(1.0, "rgb(255, 0, 0)");

            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);
            
            this._textures.colorRamp = this._createTexture(canvas);
        },

        _reset: function() {
            const mapSize = this._map.getSize();
            this._canvas.width = mapSize.x;
            this._canvas.height = mapSize.y;
            this._canvas.style.width = mapSize.x + 'px';
            this._canvas.style.height = mapSize.y + 'px';

            const pos = this._map.containerPointToLayerPoint([0, 0]);
            L.DomUtil.setPosition(this._container, pos);
            
            this._draw();
        },

        _draw: function() {
            const gl = this._gl;
            if (!gl || !this._program || !this._texturesLoaded || this._point_count === 0) {
                return;
            }

            this._updateMatrix();

            gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.useProgram(this._program);

            // 修复：重新绑定缓冲区和设置顶点属性
            gl.bindBuffer(gl.ARRAY_BUFFER, this._buffers.data);
            const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
            gl.vertexAttribPointer(this._attributes.a_position, 2, gl.FLOAT, false, stride, 0);
            gl.vertexAttribPointer(this._attributes.a_wind_uv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

            // 绑定纹理
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._textures.atlas);
            gl.uniform1i(this._uniforms.u_texture_atlas, 0);

            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this._textures.colorRamp);
            gl.uniform1i(this._uniforms.u_color_ramp, 1);

            // 设置uniform变量
            gl.uniformMatrix3fv(this._uniforms.u_matrix, false, this._matrix);
            gl.uniform1f(this._uniforms.u_scale, this.options.scale);
            gl.uniform1f(this._uniforms.u_map_zoom, this._map.getZoom());

            // 启用混合模式
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            gl.drawArrays(gl.POINTS, 0, this._point_count);
        },

        _project: function(lat, lon) {
            const d = Math.PI / 180;
            const lat_rad = lat * d;
            const lon_rad = lon * d;
            const y = Math.log(Math.tan((Math.PI / 4) + (lat_rad / 2)));
            return [lon_rad, y];
        },

        _updateMatrix: function() {
            const mapBounds = this._map.getBounds();
            const ne = mapBounds.getNorthEast();
            const sw = mapBounds.getSouthWest();

            const [ne_x, ne_y] = this._project(ne.lat, ne.lng);
            const [sw_x, sw_y] = this._project(sw.lat, sw.lng);

            const scale_x = 2.0 / (ne_x - sw_x);
            const offset_x = -(ne_x + sw_x) / (ne_x - sw_x);

            // 修复：翻转 Y 轴以匹配屏幕坐标系
            const scale_y = -2.0 / (ne_y - sw_y);
            const offset_y = (ne_y + sw_y) / (ne_y - sw_y);

            this._matrix.set([
                scale_x, 0, offset_x,
                0, scale_y, offset_y,
                0, 0, 1
            ]);
        },
        
        _createProgram: function(vertSrc, fragSrc) {
            const gl = this._gl;
            const vertShader = this._createShader(gl.VERTEX_SHADER, vertSrc);
            const fragShader = this._createShader(gl.FRAGMENT_SHADER, fragSrc);
            if (!vertShader || !fragShader) return null;

            const program = gl.createProgram();
            gl.attachShader(program, vertShader);
            gl.attachShader(program, fragShader);
            gl.linkProgram(program);

            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                console.error('Program link error: ' + gl.getProgramInfoLog(program));
                gl.deleteProgram(program);
                return null;
            }
            return program;
        },

        _createShader: function(type, source) {
            const gl = this._gl;
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error('Shader compile error: ' + gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        },

        _createTexture: function(image) {
            const gl = this._gl;
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            return texture;
        }
    });

    // 工厂函数
    L.webGLWindFeatherLayer = function(options) {
        return new WebGLWindFeatherLayer(options);
    };

    L.WebGLWindFeatherLayer = WebGLWindFeatherLayer;
}