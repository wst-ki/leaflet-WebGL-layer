
export function registerWebGLScalarLayer(L) {
// WebGL Scalar Layer for Leaflet
    L.WebGLScalarLayer = L.Layer.extend({
        // 默认选项
        options: {
            zIndex: 0,
            showLabel: false,
            showColor: true,
            opacity: 1.0,
            labelCell: 64,
            magnification: 1,
            nodata: -999,
            // todo 可选值: 'nearest', 'bilinear', 'bicubic'
            interpolation: 'bicubic', // 默认为最高质量的双三次插值
            digit: 1,
            maxLabels: 300,     // 最大标签数量
            labelDensity: 1,    // 标签密度系数 (值越大标签越稀疏)
            numRange: [-999, 99999],
            scalarColor: [
                { value: 0, color: '#0000ff' },
                { value: 0.5, color: '#00ff00' },
                { value: 1.0, color: '#ff0000' }
            ]
        },

        // 初始化
        initialize: function(options) {
            L.setOptions(this, options);
            this._map = null;
            this._container = null;
            this._canvas = null;
            this._labelCanvas = null;
            this._gl = null;
            this._labelCtx = null;
            this._program = null;
            this._colorTexture = null;
            this._dataTexture = null;
            this.gridData = null;
            this.minValue = 0;
            this.maxValue = 1;

            // 网格坐标相关
            this.nRows = 0;
            this.nCols = 0;
            this.cellXSize = 0;
            this.cellYSize = 0;
            this.xllCorner = 0;
            this.yurCorner = 0;
            this.longitudeNeedsToBeWrapped = false;

            // 栅格和聚合中心初始化为空，等 setData 时再赋值
            this.field = null;
            this.tileCentersByLevel = null;
        },

        // 设置栅格数据
        // 在 L.WebGLScalarLayer 定义中，整体替换此方法
        setData: function(fieldParams) {
            // 关键：创建一个包含坐标转换逻辑的内部对象
            this.field = {
                nCols: fieldParams.nCols,
                nRows: fieldParams.nRows,
                xllCorner: fieldParams.xllCorner,
                yllCorner: fieldParams.yllCorner, // ⭐️ 已修正: field -> fieldParams
                cellXSize: fieldParams.cellXSize,
                cellYSize: fieldParams.cellYSize,
                nodata: fieldParams.nodata,
                grid: fieldParams.grid,
                
                // 从 Field.js 借鉴的核心方法
                _lonLatAtIndexes: function(i, j) {
                    const yurCorner = this.yllCorner + this.nRows * this.cellYSize;
                    const lon = this.xllCorner + (i + 0.5) * this.cellXSize;
                    const lat = yurCorner - (j + 0.5) * this.cellYSize;
                    return [lon, lat];
                },
                
                _valueAtIndexes: function(i, j) {
                    // 确保索引在边界内
                    const cj = Math.max(0, Math.min(this.nRows - 1, Math.floor(j)));
                    const ci = Math.max(0, Math.min(this.nCols - 1, Math.floor(i)));
                    if (this.grid && this.grid[cj]) {
                        return this.grid[cj][ci];
                    }
                    return this.nodata;
                }
            };

            // 为 WebGL 部分保留旧的属性
            this.gridData = this.field.grid;
            this.nRows = this.field.nRows;
            this.nCols = this.field.nCols;

            if (this.options.upsampleFactor > 1) {
                if (interpMethod === 'idw') {
                    const power = this.options.idwPower || 2; // IDW的p值
                    const neighbors = this.options.idwNeighbors || 8; // 考虑的邻近点数量
                    // console.log(`🔍 Upsampling grid with IDW: power=${power}, neighbors=${neighbors}`);
                    finalGrid = this._upsampleGridIDW(fieldParams.grid, this.options.upsampleFactor, power, neighbors);
                } else { // 默认为双线性
                    finalGrid = this._upsampleGridBilinear(fieldParams.grid, this.options.upsampleFactor);
                }
            }
            // 用 field 的元数据精确计算 bounds
            const yurCorner = this.field.yllCorner + this.field.nRows * this.field.cellYSize;
            const xurCorner = this.field.xllCorner + this.field.nCols * this.field.cellXSize;
            this.dataBounds = L.latLngBounds(
                L.latLng(this.field.yllCorner, this.field.xllCorner),
                L.latLng(yurCorner, xurCorner)
            );

            this._calculateMinMax(); // 这个方法现在需要使用 this.field.grid
            this._updateTextures();
            if (!this._gl && this._canvas) {
                this._initWebGL();
            }
            if (this._gl && !this._positionBuffer) {
                this._setupGeometry();
                console.warn("⚠️ setData 被调用时，WebGL 尚未初始化。请确保先调用 layer.addTo(map)");
            }


            if (this._map) {
                this._render();
            }
        },

        // 计算数据的最小值和最大值

        // 1. 修改 _calculateMinMax 方法，增加色带范围计算
        _calculateMinMax: function() {
            if (!this.gridData) return;
            
            let min = Infinity;
            let max = -Infinity;
            
            for (let i = 0; i < this.gridData.length; i++) {
                for (let j = 0; j < this.gridData[i].length; j++) {
                    const value = this.gridData[i][j];
                    if (value !== this.options.nodata && 
                        value >= this.options.numRange[0] && 
                        value <= this.options.numRange[1]) {
                        min = Math.min(min, value);
                        max = Math.max(max, value);
                    }
                }
            }
            
            this.minValue = min;
            this.maxValue = max;
            
            // ⭐️ 新增：计算色带的实际范围
            this._calculateColorBandRange();
        },
                // 2. 新增方法：计算色带范围
        _calculateColorBandRange: function() {
            const colors = this.options.scalarColor;
            if (!colors || colors.length === 0) {
                this.colorBandMin = this.minValue;
                this.colorBandMax = this.maxValue;
                return;
            }
            
            // 从色带配置中获取实际的数值范围
            const sortedColors = colors.slice().sort((a, b) => a.value - b.value);
            this.colorBandMin = sortedColors[0].value;
            this.colorBandMax = sortedColors[sortedColors.length - 1].value;
            
            console.log(`🎨 色带范围: ${this.colorBandMin} 到 ${this.colorBandMax}`);
        },
        
        // 计算网格参数（基于 leaflet-canvas-field 的方法）
        _calculateGridParameters: function() {
            if (!this.gridData || !this.dataBounds) return;
            
            this.nRows = this.gridData.length;
            this.nCols = this.gridData[0].length;
            
            // 计算单元格大小
            this.cellXSize = (this.dataBounds.getEast() - this.dataBounds.getWest()) / this.nCols;
            this.cellYSize = (this.dataBounds.getNorth() - this.dataBounds.getSouth()) / this.nRows;
            
            // 设置角点坐标
            this.xllCorner = this.dataBounds.getWest();
            this.yurCorner = this.dataBounds.getNorth();
            
            // 检查是否需要经度包装
            this.longitudeNeedsToBeWrapped = this.dataBounds.getEast() > 180;
        },

    // 基于索引计算经纬度（来自 leaflet-canvas-field）
    _lonLatAtIndexes: function(i, j) {
        let lon = this._longitudeAtX(i);
        let lat = this._latitudeAtY(j);
        return [lon, lat];
    },

    // 基于 X 索引计算经度
    _longitudeAtX: function(i) {
        let halfXPixel = this.cellXSize / 2.0;
        let lon = this.xllCorner + halfXPixel + i * this.cellXSize;
        if (this.longitudeNeedsToBeWrapped) {
            lon = lon > 180 ? lon - 360 : lon;
        }
        return lon;
    },

    // 基于 Y 索引计算纬度
    _latitudeAtY: function(j) {
        let halfYPixel = this.cellYSize / 2.0;
        return this.yurCorner - halfYPixel - j * this.cellYSize;
    },

    // 基于索引获取数值
    _valueAtIndexes: function(i, j) {
        if (j >= 0 && j < this.nRows && i >= 0 && i < this.nCols) {
            return this.gridData[j][i];
        }
        return this.options.nodata;
    },
        // 添加到地图
        onAdd: function(map) {
            this._map = map;
            this._initCanvas();
            this._initWebGL();
            this._createShaders();
            this._setupGeometry();
            this._generateColorTexture();
            const targetPane = this.options.pane ? map.getPane(this.options.pane) : map.getPanes().overlayPane;
            targetPane.appendChild(this._container);
            // 添加到地图容器
            map._panes.overlayPane.appendChild(this._container);
            
            // 监听地图事件
            map.on('zoom', this._onMapChange, this);
            map.on('move', this._onMapChange, this);
            map.on('resize', this._onMapChange, this);
            
            this._onMapChange();
        },

        // 从地图移除
        onRemove: function(map) {
            if (this._container && this._container.parentNode) {
                this._container.parentNode.removeChild(this._container);
            }
            
            map.off('zoom', this._onMapChange, this);
            map.off('move', this._onMapChange, this);
            map.off('resize', this._onMapChange, this);
            
            this._cleanup();
        },

        // 初始化画布
        _initCanvas: function() {
            this._container = L.DomUtil.create('div', 'leaflet-webgl-scalar-layer');
            this._container.style.position = 'absolute';
            this._container.style.zIndex = this.options.zIndex;
            
            // WebGL 画布
            this._canvas = L.DomUtil.create('canvas', '');
            this._canvas.style.position = 'absolute';
            this._canvas.style.left = '0';
            this._canvas.style.top = '0';
            
            // 标签画布
            this._labelCanvas = L.DomUtil.create('canvas', '');
            this._labelCanvas.style.position = 'absolute';
            this._labelCanvas.style.left = '0';
            this._labelCanvas.style.top = '0';
            this._labelCanvas.style.pointerEvents = 'none';
            
            this._container.appendChild(this._canvas);
            this._container.appendChild(this._labelCanvas);
            
            this._labelCtx = this._labelCanvas.getContext('2d');
        },

        // 初始化 WebGL
        _initWebGL: function() {
                    this._gl = this._canvas.getContext('webgl') || this._canvas.getContext('experimental-webgl');
                    
                    if (!this._gl) {
                        console.error('WebGL not supported');
                        return;
                    }
                    
                    const gl = this._gl;
                    
                    // 检查浮点纹理支持
                    if (gl.getExtension('OES_texture_float')) {
                        this._useFloatTexture = true;
                        // console.log('✅ Float textures supported (OES_texture_float)');

                        // ⭐️ 关键新增：检查浮点纹理的线性插值支持
                        if (gl.getExtension('OES_texture_float_linear')) {
                            this._canLinearFilterFloat = true;
                            // console.log('✅ Linear filtering for float textures supported (OES_texture_float_linear)');
                        } else {
                            this._canLinearFilterFloat = false;
                            // console.warn('⚠️ Linear filtering for float textures NOT supported. Will fall back to NEAREST.');
                        }

                    } else {
                        this._useFloatTexture = false;
                        this._canLinearFilterFloat = false; // 如果不支持浮点纹理，自然也不支持其线性插值
                        // console.warn('⚠️ Float textures not supported. Using UNSIGNED_BYTE.');
                    }
                    
                    // 启用混合
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    
                    // 设置视口
                    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
                },

        // 创建着色器程序
        _createShaders: function() {
            const gl = this._gl;
            
            // 顶点着色器源码
            // 修改后的顶点着色器
// ⭐️ REVISED VERTEX SHADER ⭐️
            const vertexShaderSource = `
                attribute vec2 a_position; // Will be a simple quad from (0,0) to (1,1)
                attribute vec2 a_texCoord;

                uniform vec2 u_resolution;      // Resolution of the canvas (e.g., 800x600)
                uniform vec4 u_pixel_bounds;    // The projected pixel bounds of our data [minX, minY, maxX, maxY]

                varying vec2 v_texCoord;

                void main() {
                    // Interpolate the pixel position of the vertex
                    // a_position.x is 0 for the left edge, 1 for the right edge
                    // a_position.y is 0 for the bottom edge, 1 for the top edge
                    float pixel_x = u_pixel_bounds.x + (a_position.x * (u_pixel_bounds.z - u_pixel_bounds.x));
                    float pixel_y = u_pixel_bounds.y + (a_position.y * (u_pixel_bounds.w - u_pixel_bounds.y));

                    // Convert the pixel position to WebGL clip space
                    vec2 clip_space = (vec2(pixel_x, pixel_y) / u_resolution) * 2.0 - 1.0;

                    // gl_Position requires Y to be flipped
                    gl_Position = vec4(clip_space * vec2(1.0, -1.0), 0.0, 1.0);

                    v_texCoord = a_texCoord;
                }
            `;
            
            // 片段着色器源码
            // 在 fragmentShaderSource 中修改数据解码部分
            // 在 _createShaders 函数内, 替换 fragmentShaderSource 字符串
            // ⭐️ 方法二：高性能双三次插值着色器
            const fragmentShaderSource = `
                precision mediump float;
                
                uniform sampler2D u_dataTexture;
                uniform sampler2D u_colorTexture;
                uniform vec2 u_textureSize; // ⭐️ 新增：数据纹理的尺寸（宽、高）
                uniform float u_colorBandMin;    // ⭐️ 新增
                uniform float u_colorBandMax;    // ⭐️ 新增
                uniform float u_opacity;
                uniform float u_minValue;
                uniform float u_maxValue;
                uniform float u_nodata;
                uniform vec2 u_numRange;
                uniform bool u_showColor;
                
                varying vec2 v_texCoord;

                // ⭐️ 新增：三次样条插值函数
                vec4 cubic(float v) {
                    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
                    vec4 s = n * n * n;
                    float x = s.x;
                    float y = s.y - 4.0 * s.x;
                    float z = s.z - 4.0 * s.y + 6.0 * s.x;
                    float w = 6.0 - x - y - z;
                    return vec4(x, y, z, w) * (1.0/6.0);
                }

                // ⭐️ 新增：双三次纹理采样函数
                float textureBicubic(sampler2D sampler, vec2 texCoords) {
                    vec2 texelSize = 1.0 / u_textureSize;
                    vec2 f = fract(texCoords * u_textureSize); // 获取小数部分

                    // 计算16个采样点的坐标
                    vec2 p0 = texCoords - f * texelSize - texelSize;
                    vec2 p1 = p0 + texelSize;
                    vec2 p2 = p1 + texelSize;
                    vec2 p3 = p2 + texelSize;

                    // 对4行进行三次插值
                    vec4 c0 = cubic(f.x);
                    vec4 c1 = cubic(f.x);
                    vec4 c2 = cubic(f.x);
                    vec4 c3 = cubic(f.x);

                    vec4 v0 = vec4(texture2D(sampler, vec2(p0.x, p0.y)).r, texture2D(sampler, vec2(p1.x, p0.y)).r, texture2D(sampler, vec2(p2.x, p0.y)).r, texture2D(sampler, vec2(p3.x, p0.y)).r);
                    vec4 v1 = vec4(texture2D(sampler, vec2(p0.x, p1.y)).r, texture2D(sampler, vec2(p1.x, p1.y)).r, texture2D(sampler, vec2(p2.x, p1.y)).r, texture2D(sampler, vec2(p3.x, p1.y)).r);
                    vec4 v2 = vec4(texture2D(sampler, vec2(p0.x, p2.y)).r, texture2D(sampler, vec2(p1.x, p2.y)).r, texture2D(sampler, vec2(p2.x, p2.y)).r, texture2D(sampler, vec2(p3.x, p2.y)).r);
                    vec4 v3 = vec4(texture2D(sampler, vec2(p0.x, p3.y)).r, texture2D(sampler, vec2(p1.x, p3.y)).r, texture2D(sampler, vec2(p2.x, p3.y)).r, texture2D(sampler, vec2(p3.x, p3.y)).r);
                    
                    // 对插值后的4行进行加权求和
                    float r0 = dot(v0, c0);
                    float r1 = dot(v1, c1);
                    float r2 = dot(v2, c2);
                    float r3 = dot(v3, c3);

                    vec4 c = cubic(f.y);
                    return dot(vec4(r0, r1, r2, r3), c);
                }

                void main() {
                    if (!u_showColor) {
                        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
                        return;
                    }
                    
                    // ⭐️ 使用新的双三次采样函数，而不是 texture2D
                    float value = textureBicubic(u_dataTexture, v_texCoord);
                    
                    // --- 后续逻辑保持不变 ---
                    if (abs(value - u_nodata) < 0.001 || value < u_numRange.x || value > u_numRange.y) {
                        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
                        return;
                    }
                    
                    // ⭐️ 修改：使用色带的绝对值范围进行映射
                    float rangeForColor = u_colorBandMax - u_colorBandMin;
                    if (rangeForColor <= 0.001) { rangeForColor = 1.0; }
                    float normalizedValueForColor = clamp((value - u_colorBandMin) / rangeForColor, 0.0, 1.0);
                    
                    vec4 color = texture2D(u_colorTexture, vec2(normalizedValueForColor, 0.5));
                    
                    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
                }
            `;
            
            // 编译着色器
            const vertexShader = this._compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
            const fragmentShader = this._compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
            
            // 创建程序
            this._program = gl.createProgram();
            gl.attachShader(this._program, vertexShader);
            gl.attachShader(this._program, fragmentShader);
            gl.linkProgram(this._program);
            
            if (!gl.getProgramParameter(this._program, gl.LINK_STATUS)) {
                console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(this._program));
                return;
            }
            
            gl.useProgram(this._program);
            
            // 获取属性和uniform位置
            this._locations = {
                position: gl.getAttribLocation(this._program, 'a_position'),
                texCoord: gl.getAttribLocation(this._program, 'a_texCoord'),
                resolution: gl.getUniformLocation(this._program, 'u_resolution'),
                dataBounds: gl.getUniformLocation(this._program, 'u_dataBounds'), // 原u_bounds改为u_dataBounds
                mapBounds: gl.getUniformLocation(this._program, 'u_mapBounds'),
                // NEW: This is the critical uniform for positioning
                pixelBounds: gl.getUniformLocation(this._program, 'u_pixel_bounds'), 
                dataTexture: gl.getUniformLocation(this._program, 'u_dataTexture'),
                colorTexture: gl.getUniformLocation(this._program, 'u_colorTexture'),
                opacity: gl.getUniformLocation(this._program, 'u_opacity'),
                minValue: gl.getUniformLocation(this._program, 'u_minValue'),
                maxValue: gl.getUniformLocation(this._program, 'u_maxValue'),
                nodata: gl.getUniformLocation(this._program, 'u_nodata'),
                numRange: gl.getUniformLocation(this._program, 'u_numRange'),
                showColor: gl.getUniformLocation(this._program, 'u_showColor'),
                useFloatTexture: gl.getUniformLocation(this._program, 'u_useFloatTexture'),
                textureSize: gl.getUniformLocation(this._program, 'u_textureSize'),
                colorBandMin: gl.getUniformLocation(this._program, 'u_colorBandMin'),
                colorBandMax: gl.getUniformLocation(this._program, 'u_colorBandMax'),
            };
        },

        // 编译着色器
        _compileShader: function(gl, type, source) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            
            return shader;
        },

        // 设置几何体
        _setupGeometry: function() {
            const gl = this._gl;

            // ⭐️ REVISED GEOMETRY ⭐️
            // Create a simple quad from (0,0) to (1,1)
            // This represents the normalized space of our data grid.
            const positions = new Float32Array([
                0, 0,  // 左下 (Bottom-Left)
                1, 0,  // 右下 (Bottom-Right)
                0, 1,  // 左上 (Top-Left)
                1, 1   // 右上 (Top-Right)
            ]);
            
            const texCoords = new Float32Array([
                0, 0,  // 改为不翻转
                1, 0,
                0, 1,
                1, 1
            ]);

            // Position buffer
            this._positionBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

            // Texture coordinate buffer
            this._texCoordBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this._texCoordBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
        },


        // 生成颜色纹理
        // 4. 修改 _generateColorTexture 方法，使用绝对值范围
        _generateColorTexture: function() {
            const gl = this._gl;
            const colors = this.options.scalarColor;
            const width = 1024;
            const colorData = new Uint8Array(width * 4);
            
            // 对颜色进行排序
            const sortedColors = colors.slice().sort((a, b) => a.value - b.value);
            
            // ⭐️ 修改：使用色带的绝对值范围
            const colorMin = sortedColors[0].value;
            const colorMax = sortedColors[sortedColors.length - 1].value;
            const colorRange = colorMax - colorMin;
            
            for (let i = 0; i < width; i++) {
                // 将纹理索引映射到色带的绝对值范围
                const absoluteValue = colorMin + (i / (width - 1)) * colorRange;
                const color = this._interpolateColor(sortedColors, absoluteValue);
                
                colorData[i * 4] = color.r;
                colorData[i * 4 + 1] = color.g;
                colorData[i * 4 + 2] = color.b;
                colorData[i * 4 + 3] = 255;
            }
            
            this._colorTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this._colorTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorData);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); 
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        },

        // 颜色插值
        // 3. 修改 _interpolateColor 方法，使用绝对值而不是归一化值
        _interpolateColor: function(colors, t) {
            if (colors.length === 0) return { r: 0, g: 0, b: 0 };
            if (colors.length === 1) return this._hexToRgb(colors[0].color);
            
            // ⭐️ 修改：t 现在是绝对值，不再是归一化的 [0,1] 值
            const sortedColors = colors.slice().sort((a, b) => a.value - b.value);
            
            // 如果 t 超出色带范围，返回边界颜色
            if (t <= sortedColors[0].value) {
                return this._hexToRgb(sortedColors[0].color);
            }
            if (t >= sortedColors[sortedColors.length - 1].value) {
                return this._hexToRgb(sortedColors[sortedColors.length - 1].color);
            }
            
            // 找到 t 所在的色带区间
            let i = 0;
            while (i < sortedColors.length - 1 && t > sortedColors[i + 1].value) {
                i++;
            }
            
            if (i === sortedColors.length - 1) {
                return this._hexToRgb(sortedColors[i].color);
            }
            
            const color1 = this._hexToRgb(sortedColors[i].color);
            const color2 = this._hexToRgb(sortedColors[i + 1].color);
            
            // 计算在当前区间内的插值位置
            const valueDiff = sortedColors[i + 1].value - sortedColors[i].value;
            const localT = valueDiff === 0 ? 0 : (t - sortedColors[i].value) / valueDiff;
            
            return {
                r: Math.round(color1.r + (color2.r - color1.r) * localT),
                g: Math.round(color1.g + (color2.g - color1.g) * localT),
                b: Math.round(color1.b + (color2.b - color1.b) * localT)
            };
        },
        // ⭐️ 方法一：IDW 升采样核心函数
        // 将此函数添加到您的 WebGLScalarLayer 类中
        _upsampleGridIDW: function(grid, factor, power, neighbors) {
            if (factor <= 1) return grid;

            const oldRows = grid.length;
            const oldCols = grid[0].length;
            const newRows = Math.floor(oldRows * factor);
            const newCols = Math.floor(oldCols * factor);

            const newGrid = Array(newRows).fill(0).map(() => Array(newCols).fill(0));
            const nodata = this.options.nodata;

            for (let j = 0; j < newRows; j++) {
                for (let i = 0; i < newCols; i++) {
                    const old_i_float = i / factor;
                    const old_j_float = j / factor;

                    let totalValue = 0;
                    let totalWeight = 0;
                    let foundPoints = [];

                    // 搜索邻近点（为了性能，我们只在一个小窗口内搜索）
                    const searchRadius = Math.ceil(Math.sqrt(neighbors));
                    const i_center = Math.round(old_i_float);
                    const j_center = Math.round(old_j_float);

                    for (let sy = -searchRadius; sy <= searchRadius; sy++) {
                        for (let sx = -searchRadius; sx <= searchRadius; sx++) {
                            const cx = i_center + sx;
                            const cy = j_center + sy;

                            if (cy >= 0 && cy < oldRows && cx >= 0 && cx < oldCols) {
                                const val = grid[cy][cx];
                                if (val !== nodata) {
                                    const d = Math.sqrt(Math.pow(old_i_float - cx, 2) + Math.pow(old_j_float - cy, 2));
                                    foundPoints.push({ dist: d, value: val });
                                }
                            }
                        }
                    }
                    
                    // 如果找不到任何有效点，则使用最近邻
                    if(foundPoints.length === 0){
                        newGrid[j][i] = grid[Math.min(oldRows-1, j_center)][Math.min(oldCols-1, i_center)];
                        continue;
                    }

                    // 排序并选取最近的 N 个点
                    foundPoints.sort((a, b) => a.dist - b.dist);
                    const nearestPoints = foundPoints.slice(0, neighbors);

                    for(const p of nearestPoints){
                        // 如果距离为0（完全重合），直接取该点的值
                        if (p.dist === 0) {
                            totalValue = p.value;
                            totalWeight = 1;
                            break;
                        }
                        const weight = 1.0 / Math.pow(p.dist, power);
                        totalValue += weight * p.value;
                        totalWeight += weight;
                    }

                    if (totalWeight > 0) {
                        newGrid[j][i] = totalValue / totalWeight;
                    } else {
                        // 理论上不会进入这里，除非所有点距离都是无穷大
                        newGrid[j][i] = nodata;
                    }
                }
            }
            // console.log(`🚀 Upsampled grid via IDW to ${newCols}x${newRows}`);
            return newGrid;
        },
        // 十六进制颜色转RGB
        _hexToRgb: function(hex) {
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : { r: 0, g: 0, b: 0 };
        },

        // 更新数据纹理
        // 在 _updateTextures 方法中添加详细的调试和修复
        _updateTextures: function() {
            if (!this._gl || !this.gridData) return;
            
            const gl = this._gl;
            const data = this.gridData;
            const height = data.length;
            const width = data[0].length;
            
            // console.log("🔍 开始创建纹理，数据维度:", width, "x", height);
            // console.log("🔍 原始数据样本:", data[0].slice(0, 5), "...", data[height-1].slice(0, 5));
            // console.log("🔍 数据范围:", this.minValue, "到", this.maxValue);
            
            let textureData, format, type;
            
            if (this._useFloatTexture) {
                // 🔧 浮点纹理路径 - 添加详细验证
                textureData = new Float32Array(width * height);
                format = gl.LUMINANCE;
                type = gl.FLOAT;
                
                let validCount = 0, invalidCount = 0, totalSum = 0;
                
                for (let i = 0; i < height; i++) {
                    for (let j = 0; j < width; j++) {
                        const value = data[i][j];
                        const index = i * width + j;
                        
                        // 🔧 关键修复：确保无效数据用特殊值标记
                        if (value === this.options.nodata || 
                            value < this.options.numRange[0] || 
                            value > this.options.numRange[1] ||
                            isNaN(value)) {
                            
                            // 使用一个明显异常的值来标记无效数据
                            textureData[index] = -9999.0;
                            invalidCount++;
                        } else {
                            textureData[index] = value;
                            validCount++;
                            totalSum += value;
                        }
                    }
                }
                
                // console.log("🔍 浮点纹理统计:");
                // console.log("  - 有效数据点:", validCount);
                // console.log("  - 无效数据点:", invalidCount);
                // console.log("  - 平均值:", validCount > 0 ? (totalSum / validCount).toFixed(3) : "N/A");
                // console.log("  - 纹理数据前10个值:", Array.from(textureData.slice(0, 10)));
                // console.log("  - 纹理数据后10个值:", Array.from(textureData.slice(-10)));
                
                // 🔧 验证纹理数据是否全为无效值
                const nonInvalidCount = Array.from(textureData).filter(v => v !== -9999.0).length;
                // console.log("  - 非无效值数量:", nonInvalidCount);
                
            } else {
                // 8位整数纹理路径
                textureData = new Uint8Array(width * height);
                format = gl.LUMINANCE;
                type = gl.UNSIGNED_BYTE;
                
                const minVal = this.minValue;
                const maxVal = this.maxValue;
                const range = (maxVal - minVal) === 0 ? 1 : (maxVal - minVal);
                
                // console.log("🔍 8位纹理标准化参数:", { minVal, maxVal, range });
                
                for (let i = 0; i < height; i++) {
                    for (let j = 0; j < width; j++) {
                        const value = data[i][j];
                        const index = i * width + j;
                        
                        if (value === this.options.nodata || 
                            value < this.options.numRange[0] || 
                            value > this.options.numRange[1] ||
                            isNaN(value)) {
                            textureData[index] = 0; // 无效数据用0标记
                        } else {
                            const normalized = (value - minVal) / range;
                            const byteValue = Math.max(1, Math.min(255, Math.floor(normalized * 254) + 1));
                            textureData[index] = byteValue;
                        }
                    }
                }
                
                // console.log("🔍 8位纹理数据前10个值:", Array.from(textureData.slice(0, 10)));
            }
            
            // 🔧 关键修复：纹理创建前的WebGL状态检查
            if (!this._dataTexture) {
                this._dataTexture = gl.createTexture();
                // console.log("🔍 创建新纹理对象:", !!this._dataTexture);
            }
            
            // 🔧 绑定前检查当前WebGL状态
            const currentError = gl.getError();
            if (currentError !== gl.NO_ERROR) {
                console.warn("🔍 绑定前WebGL错误:", currentError);
            }
            
            // 绑定纹理
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._dataTexture);
            
            // ⭐️ 关键修改：根据支持情况动态选择纹理过滤器
            const filter = (this._useFloatTexture && this._canLinearFilterFloat) ? gl.LINEAR : gl.NEAREST;
            
            if (filter === gl.LINEAR) {
                console.log('🚀 Using LINEAR filter for smooth rendering.');
            } else {
                console.log('🎨 Using NEAREST filter (blocky rendering).');
            }

            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            
            
            try {
                // 🔧 上传纹理数据
                gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, format, type, textureData);
                
                // 立即检查错误
                const textureError = gl.getError();
                if (textureError !== gl.NO_ERROR) {
                    console.error('🔥 纹理上传错误:', textureError);
                    console.error('错误详情:', {
                        format: format,
                        width: width,
                        height: height,
                        type: type,
                        dataLength: textureData.length
                    });
                    return;
                }
                
                // console.log(`✅ 数据纹理上传成功: ${width}x${height}, 格式: ${this._useFloatTexture ? 'FLOAT' : 'UNSIGNED_BYTE'}`);
                
                // 🔧 验证纹理是否正确绑定
                const boundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
                // console.log("🔍 当前绑定的纹理:", boundTexture === this._dataTexture ? "正确" : "错误");
                
            } catch (e) {
                console.error('🔥 纹理创建异常:', e);
                this._dataTexture = null;
            }
        },

        // 地图变化处理
        // 在 L.WebGLScalarLayer 定义中找到并替换此方法
        _onMapChange: function() {
            if (!this._map) return;
            
            const size = this._map.getSize();
            const topLeft = this._map.containerPointToLayerPoint([0, 0]);
            
            // 更新容器位置和大小
            L.DomUtil.setPosition(this._container, topLeft);
            this._container.style.width = size.x + 'px';
            this._container.style.height = size.y + 'px';
            
            // ⭐️ 修正部分：同时为 WebGL 和 Label 画布适配高清屏
            const pixelRatio = window.devicePixelRatio || 1;
            const canvasWidth = size.x * pixelRatio;
            const canvasHeight = size.y * pixelRatio;
            
            // 更新 WebGL 画布大小
            this._canvas.width = canvasWidth;
            this._canvas.height = canvasHeight;
            this._canvas.style.width = size.x + 'px';
            this._canvas.style.height = size.y + 'px';
            // console.log("canvas width height", this._canvas.width, this._canvas.height);

            // 更新 Label 画布大小 (这是解决模糊的关键)
            this._labelCanvas.width = canvasWidth;
            this._labelCanvas.height = canvasHeight;
            this._labelCanvas.style.width = size.x + 'px';
            this._labelCanvas.style.height = size.y + 'px';
            
            if (this._gl) {
                this._gl.viewport(0, 0, canvasWidth, canvasHeight);
            }
            
            this._render();
        },

        // 渲染
// ⭐️ REVISED RENDER FUNCTION ⭐️
// ⭐️ REVISED RENDER FUNCTION (CORRECTED) ⭐️
        _render: function() {
            // Early exit if not ready
            if (!this._gl || !this._program || !this.gridData || !this.dataBounds) {
                // console.log("🔥 _render aorted: Not ready.");
                return;
            }
            
            const gl = this._gl;
            const mapSize = this._map.getSize(); // Canvas CSS size
            const pixelRatio = window.devicePixelRatio || 1;
            const canvasResolution = [this._canvas.width, this._canvas.height]; // Actual buffer size

            // === Calculate Pixel Bounds using Leaflet ===
            const topLeft = this._map.latLngToContainerPoint(this.dataBounds.getNorthWest());
            const bottomRight = this._map.latLngToContainerPoint(this.dataBounds.getSouthEast());

            const pixelBounds = {
                minX: topLeft.x * pixelRatio,
                minY: topLeft.y * pixelRatio,
                maxX: bottomRight.x * pixelRatio,
                maxY: bottomRight.y * pixelRatio,
            };

            // Clear the canvas
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            // Use the shader program
            gl.useProgram(this._program);

            // Setup vertex attributes
            gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer);
            gl.enableVertexAttribArray(this._locations.position);
            gl.vertexAttribPointer(this._locations.position, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this._texCoordBuffer);
            gl.enableVertexAttribArray(this._locations.texCoord);
            gl.vertexAttribPointer(this._locations.texCoord, 2, gl.FLOAT, false, 0, 0);

            // === Set Uniforms ===
            gl.uniform2f(this._locations.resolution, canvasResolution[0], canvasResolution[1]);
            gl.uniform4f(this._locations.pixelBounds, pixelBounds.minX, pixelBounds.minY, pixelBounds.maxX, pixelBounds.maxY);
            gl.uniform1f(this._locations.colorBandMin, this.colorBandMin || this.minValue);
            gl.uniform1f(this._locations.colorBandMax, this.colorBandMax || this.maxValue);
            gl.uniform1i(this._locations.useFloatTexture, this._useFloatTexture);
            gl.uniform1f(this._locations.opacity, this.options.opacity);
            gl.uniform1f(this._locations.minValue, this.minValue);
            gl.uniform1f(this._locations.maxValue, this.maxValue);
            gl.uniform1f(this._locations.nodata, this.options.nodata);
            gl.uniform2f(this._locations.numRange, this.options.numRange[0], this.options.numRange[1]);
            gl.uniform1i(this._locations.showColor, this.options.showColor);
            if (this._locations.textureSize) {
                gl.uniform2f(this._locations.textureSize, this.nCols, this.nRows);
                    }
            // Bind textures
            gl.activeTexture(gl.TEXTURE0);
            // ⭐️⭐️⭐️ 核心修正：将 gl.TEXTURE_D 改为 gl.TEXTURE_2D ⭐️⭐️⭐️
            gl.bindTexture(gl.TEXTURE_2D, this._dataTexture);
            // console.log("🔍 dataTexture存在:", !!this._dataTexture);
            // console.log("🔍 当前绑定的纹理:", gl.getParameter(gl.TEXTURE_BINDING_2D));
            gl.uniform1i(this._locations.dataTexture, 0);

            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this._colorTexture);
            gl.uniform1i(this._locations.colorTexture, 1);

            // Draw the quad
            // console.log("🔥 Drawing with pixel bounds:", pixelBounds);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // Draw labels if needed
            if (this.options.showLabel) {
                this._drawLabels();
            }
        },

        // 绘制标签
        // 绘制标签（使用优化的坐标计算）
        // 🔧 优化后的 _drawLabels 方法

        // 绘制标签（已修复边界问题）
        _drawLabels: function() {
            if (!this.field || !this._labelCtx || !this.dataBounds || !this.dataBounds.isValid()) return;

            const ctx = this._labelCtx;
            const pixelRatio = window.devicePixelRatio || 1;
            const mapBounds = this._map.getBounds();
            const canvas = ctx.canvas;

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            ctx.scale(pixelRatio, pixelRatio);

            const dataTopLeft = this._map.latLngToContainerPoint(this.dataBounds.getNorthWest());
            const dataBottomRight = this._map.latLngToContainerPoint(this.dataBounds.getSouthEast());
            const dataPixelWidth = dataBottomRight.x - dataTopLeft.x;
            const pixelPerCellX = dataPixelWidth / this.field.nCols;

            const baseLabelSize = 75;
            const TARGET_PIXEL_FOR_LABEL = baseLabelSize / (this.options.labelDensity || 1);
            let aggLevel = Math.max(TARGET_PIXEL_FOR_LABEL / pixelPerCellX, 0.01);

            const intersection = this._calculateBoundsIntersection(mapBounds, this.dataBounds);
            if (!intersection) {
                ctx.restore();
                return;
            }

            const startI = Math.max(0, Math.floor((intersection.getWest() - this.field.xllCorner) / this.field.cellXSize));
            const endI = Math.min(this.field.nCols, Math.ceil((intersection.getEast() - this.field.xllCorner) / this.field.cellXSize));
            const startJ = Math.max(0, Math.floor((this.field.yllCorner + this.field.nRows * this.field.cellYSize - intersection.getNorth()) / this.field.cellYSize));
            const endJ = Math.min(this.field.nRows, Math.ceil((this.field.yllCorner + this.field.nRows * this.field.cellYSize - intersection.getSouth()) / this.field.cellYSize));

            const fontSize = this.options.fontSize || 12;
            ctx.font = `${fontSize}px Arial`;
            ctx.fillStyle = 'rgba(0,0,0,0.9)';
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2.5;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            let labelCount = 0;
            const maxLabels = this.options.maxLabels || 1000;

            for (let j = startJ; j < endJ && labelCount < maxLabels; j += aggLevel) {
                for (let i = startI; i < endI && labelCount < maxLabels; i += aggLevel) {
                    
                    const centerI = i + aggLevel / 2;
                    const centerJ = j + aggLevel / 2;
                    const [lon, lat] = this.field._lonLatAtIndexes(centerI, centerJ);
                    const latlng = L.latLng(lat, lon);

                    // ⭐️ 新增：核心修复代码！确保经纬度在数据边界内 ⭐️
                    // This check ensures we don't even consider points outside our data's own bounds.
                    if (!this.dataBounds.contains(latlng)) {
                        continue;
                    }
                    
                    // (保留原有逻辑) 进一步检查是否在屏幕可见区域内，提高性能
                    if (!mapBounds.contains(latlng)) {
                        continue;
                    }

                    const val = this.field._valueAtIndexes(centerI, centerJ);
                    if (val === this.options.nodata || isNaN(val)) continue;
                    
                    const point = this._map.latLngToContainerPoint(latlng);
                    const displayValue = val.toFixed(this.options.digit || 1);
                    
                    ctx.strokeText(displayValue, point.x, point.y);
                    ctx.fillText(displayValue, point.x, point.y);

                    labelCount++;
                }
            }

            ctx.restore();
        },
        
        // 辅助方法：计算两个边界的交集
        _calculateBoundsIntersection: function(bounds1, bounds2) {
            const south = Math.max(bounds1.getSouth(), bounds2.getSouth());
            const west = Math.max(bounds1.getWest(), bounds2.getWest());
            const north = Math.min(bounds1.getNorth(), bounds2.getNorth());
            const east = Math.min(bounds1.getEast(), bounds2.getEast());
            
            if (west >= east || south >= north) {
                return null; // 没有交集
            }
            
            return L.latLngBounds(L.latLng(south, west), L.latLng(north, east));
        },
                // 🔧 辅助方法：计算视图覆盖比例
        // 🔧 辅助方法：计算视图覆盖比例（已修复）
        _calculateViewCoverage: function(mapBounds, dataBounds) {
            // 首先确保 dataBounds 有效
            if (!dataBounds || !dataBounds.isValid()) {
                return 0;
            }

            // 手动计算两个边界框的交集
            const south = Math.max(mapBounds.getSouth(), dataBounds.getSouth());
            const west = Math.max(mapBounds.getWest(), dataBounds.getWest());
            const north = Math.min(mapBounds.getNorth(), dataBounds.getNorth());
            const east = Math.min(mapBounds.getEast(), dataBounds.getEast());

            // 检查是否存在有效的交集区域 (如果 west > east 或 south > north，则无交集)
            if (west >= east || south >= north) {
                return 0; // 没有重叠部分
            }

            // 创建代表交集的 L.LatLngBounds 对象
            const intersection = L.latLngBounds(L.latLng(south, west), L.latLng(north, east));

            // 计算面积比例（简化的矩形面积计算）
            const mapArea = (mapBounds.getEast() - mapBounds.getWest()) *
                            (mapBounds.getNorth() - mapBounds.getSouth());

            const intersectionArea = (intersection.getEast() - intersection.getWest()) *
                                    (intersection.getNorth() - intersection.getSouth());

            // 防止在地图面积为0时出现除零错误
            if (mapArea === 0) {
                return 0;
            }

            return Math.min(1, intersectionArea / mapArea);
        },
        // 设置标签密度
        setLabelDensity: function(density) {
        this.options.labelDensity = Math.max(0.1, density); // 最小值限制
            if (this.options.showLabel) {
                this._render();
            }
        },
        // 设置选项的方法
        setOpacity: function(opacity) {
            this.options.opacity = opacity;
            this._render();
        },

        setShowColor: function(show) {
            this.options.showColor = show;
            this._render();
        },

        setShowLabel: function(show) {
            this.options.showLabel = show;
            this._render();
        },

        setScalarColor: function(colors) {
            this.options.scalarColor = colors;
            this._calculateColorBandRange(); // ⭐️ 新增：重新计算色带范围
            this._generateColorTexture();
            this._render();
        },

        // 清理资源
        _cleanup: function() {
            if (this._gl) {
                if (this._dataTexture) {
                    this._gl.deleteTexture(this._dataTexture);
                }
                if (this._colorTexture) {
                    this._gl.deleteTexture(this._colorTexture);
                }
                if (this._program) {
                    this._gl.deleteProgram(this._program);
                }
                // 在_cleanup中添加缓冲区清理
                if (this._positionBuffer) {
                    this._gl.deleteBuffer(this._positionBuffer);
                    this._positionBuffer = null;
                }
                if (this._texCoordBuffer) {
                    this._gl.deleteBuffer(this._texCoordBuffer);
                    this._texCoordBuffer = null;
                }
            }
            
        }
    });
}