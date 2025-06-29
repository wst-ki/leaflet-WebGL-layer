export function registerWebGLWindLayer(l) {
    l.WindLayer = (l.Layer ? l.Layer : l.Class).extend({
    options: {
        displayValues: true,
        displayOptions: {
            velocityType: "",
            displayPosition: "",
            displayEmptyString: ""
        },
        maxVelocity: 10,
        data: null,
        zIndex: 0,
        magnification: 1,
        uvExaggerate: 1,
        color: ["rgba(250,250,250,0.9)"],
        velocityScale: 0.005,
        globalAlpha: 0.9,
        particleAge: 30,
        particleMultiplier: 350,
        frame_rate: 30,
        lineWidth: 1,
        type: "wind",
        particle: true,
        arrow: true,
        callback: null,
        uData: null,
        vData: null,
        range: {
            scale: 0,
            startLat: 0,
            startLon: 0,
            endLon: 0,
            endLat: 0,
            width: 0,
            height: 0
        }
    },

    _map: null,
    _canvasLayer: null,
    _webglRenderer: null,
    _context: null,
    _timer: 0,
    _mouseControl: null,
    _animationId: null,

    initialize: function(options) {
        l.setOptions(this, options);
    },

    onAdd: function(map) {
        this._canvasLayer = l.canvasLayer(this.options).delegate(this);
        this._canvasLayer.addTo(map);
        this._map = map;
    },

    onRemove: function() {
        this._destroyWind();
    },

    setData: function(data) {
        this.options.data = data;
        try {
            if (this._webglRenderer) {
                this._webglRenderer.setData(data);
                this._clearAndRestart();
            }
            this.fire("load");
        } catch (e) {
            console.error("Error setting data:", e);
        }
    },

    imgCanvas: document.createElement("canvas"),
    imgData: null,

    setDataP: function() {
        const self = this;
        const headerU = {
            lo1: self.options.range.startLon,
            la1: self.options.range.startLat,
            d: self.options.range.scale,
            nx: self.options.range.width,
            ny: self.options.range.height,
            nodata: -999,
            dataType: "windU"
        };
        const headerV = {
            lo1: self.options.range.startLon,
            la1: self.options.range.startLat,
            d: self.options.range.scale,
            nx: self.options.range.width,
            ny: self.options.range.height,
            nodata: -999,
            dataType: "windV"
        };
        const data = [{
            header: headerU,
            data: self.options.uData
        }, {
            header: headerV,
            data: self.options.vData
        }];
        
        self.options.data = data;
        if (self._webglRenderer) {
            self._webglRenderer.setData(data);
            self._clearAndRestart();
        }
        self.fire("load");
    },

    drawArrow: function() {
        if (!this._webglRenderer) return;
        this._webglRenderer.drawArrows();
    },

    onDrawLayer: function() {
        const self = this;
        if (!this._webglRenderer) {
            this._initWebGL();
            if (self.options.data && self._webglRenderer) {
                self._webglRenderer.setData(self.options.data);
            }
            return;
        }

        if (this.options.data) {
            if (this._timer) clearTimeout(self._timer);
            if (self.options.data.length !== 0) {
                self.CalcurrentRegion();
                self._clearAndRestart();
            }
        }
    },

    CalcurrentRegion: function() {
        const bounds = this._map.getBounds();
        const mapSize = this._map.getSize();
        const boundsWidth = this._map.distance(
            [bounds._southWest.lat, bounds._southWest.lng], 
            [bounds._southWest.lat, bounds._northEast.lng]
        );
        const boundsHeight = this._map.distance(
            [bounds._northEast.lat, bounds._southWest.lng], 
            [bounds._southWest.lat, bounds._southWest.lng]
        );
        const currentArea = boundsWidth * boundsHeight;
        
        const {startLon, startLat, endLon, endLat} = this.options.range;
        const dataWidth = this._map.distance([startLat, startLon], [startLat, endLon]);
        const dataHeight = this._map.distance([startLat, startLon], [endLat, startLon]);
        
        let areaRatio = dataWidth * dataHeight / currentArea * 3;
        areaRatio = areaRatio > 1 ? 1 : areaRatio;
        
        if (this._webglRenderer) {
            this._webglRenderer.setAreaRatio(areaRatio);
            this._webglRenderer.setMagnification(this.options.magnification);
        }
    },

    _startWindy: function() {
        const bounds = this._map.getBounds();
        const size = this._map.getSize();
        const canvasSize = {
            width: size.x * this.options.magnification,
            height: size.y * this.options.magnification
        };
        
        if (this._webglRenderer) {
            this._webglRenderer.start(canvasSize, bounds);
            this._animate();
        }
    },

    _animate: function() {
        if (this._webglRenderer && this.options.particle) {
            this._webglRenderer.render();
            this._animationId = requestAnimationFrame(() => this._animate());
        }
    },

    _initWebGL: function() {
        const self = this;
        const canvas = self._canvasLayer._canvas;
        
        try {
            this._webglRenderer = new WebGLWindRenderer({
                canvas: canvas,
                options: self.options
            });
            
            canvas.classList.add("velocity-overlay");
            this.onDrawLayer();
            
            this._map.on("dragend", () => self._webglRenderer.clearCanvas());
            this._map.on("zoomstart", () => self._webglRenderer.clearCanvas());
            this._map.on("resize", () => self._clearWind());
            
            this._initMouseHandler();
        } catch (error) {
            console.error("WebGL initialization failed:", error);
        }
    },

    _initMouseHandler: function() {
        if (!this._mouseControl && this.options.displayValues) {
            const displayOptions = this.options.displayOptions || {};
            displayOptions.leafletVelocity = this;
            this._mouseControl = l.control.velocity(displayOptions).addTo(this._map);
        }
    },

    _clearAndRestart: function() {
        this.CalcurrentRegion();
        
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
        
        if (this._webglRenderer) {
            this._webglRenderer.clear();
        }
        
        if (this.options.particle && this._webglRenderer) {
            this._startWindy();
        }
        
        if (this.options.arrow) {
            this.drawArrow();
        }
    },

    changeParamesReset: function(params) {
        const self = this;
        
        if (params.color) {
            self.options.color = params.color;
            if (self._webglRenderer) self._webglRenderer.setColor(params.color);
        }
        
        if (params.velocityScale) {
            self.options.velocityScale = params.velocityScale;
            if (self._webglRenderer) self._webglRenderer.setVelocityScale(params.velocityScale);
        }
        
        if (params.globalAlpha) {
            self.options.globalAlpha = params.globalAlpha;
            if (self._webglRenderer) self._webglRenderer.setGlobalAlpha(params.globalAlpha);
        }
        
        if (params.particleAge) {
            self.options.particleAge = params.particleAge;
            if (self._webglRenderer) self._webglRenderer.setParticleAge(params.particleAge);
        }
        
        if (params.particleMultiplier) {
            self.options.particleMultiplier = params.particleMultiplier;
            if (self._webglRenderer) self._webglRenderer.setParticleCount(params.particleMultiplier);
        }
        
        if (params.frame_rate) {
            self.options.frame_rate = params.frame_rate;
            if (self._webglRenderer) self._webglRenderer.setFrameRate(params.frame_rate);
        }
        
        if (params.lineWidth) {
            self.options.lineWidth = params.lineWidth;
            if (self._webglRenderer) self._webglRenderer.setLineWidth(params.lineWidth);
        }
        
        if (typeof params.arrow === "boolean") {
            self.options.arrow = params.arrow;
        }
        
        if (typeof params.particle === "boolean") {
            self.options.particle = params.particle;
        }
        
        if (self._webglRenderer) {
            self._clearAndRestart();
        }
    },

    _clearWind: function() {
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
        
        if (this._webglRenderer) {
            this._webglRenderer.stop();
            this._webglRenderer.clear();
        }
    },

    _destroyWind: function() {
        if (this._timer) clearTimeout(this._timer);
        
        this._clearWind();
        
        if (this._mouseControl && this._map) {
            this._map.removeControl(this._mouseControl);
        }
        this._mouseControl = null;
        
        if (this._webglRenderer) {
            this._webglRenderer.dispose();
            this._webglRenderer = null;
        }
        
        if (this._canvasLayer && this._map) {
            this._map.removeLayer(this._canvasLayer);
        }
    },

    _changetimeredraw: function() {
        if (this._timer) clearTimeout(this._timer);
        this._clearWind();
        
        if (this._mouseControl && this._map) {
            this._map.removeControl(this._mouseControl);
        }
        this._mouseControl = null;
        
        this.setDataP();
    }
});

// WebGL渲染器类
class WebGLWindRenderer {
    constructor({canvas, options}) {
        this.canvas = canvas;
        this.options = options;
        this.gl = null;
        this.program = null;
        this.particleProgram = null;
        this.arrowProgram = null;
        this.windData = null;
        this.particles = [];
        this.particleCount = options.particleMultiplier || 350;
        this.frameRate = 1000 / (options.frame_rate || 30);
        this.lastFrameTime = 0;
        
        this._initWebGL();
        this._createShaders();
        this._initParticles();
    }

    _initWebGL() {
        this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
        if (!this.gl) {
            throw new Error('WebGL not supported');
        }
        
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    }

    _createShaders() {
        // 粒子顶点着色器
        const particleVertexShader = `
            attribute vec2 a_position;
            attribute vec2 a_velocity;
            attribute float a_age;
            
            uniform vec2 u_resolution;
            uniform float u_time;
            uniform float u_particleAge;
            
            varying float v_alpha;
            
            void main() {
                vec2 pos = a_position + a_velocity * u_time;
                gl_Position = vec4((pos / u_resolution) * 2.0 - 1.0, 0.0, 1.0);
                gl_Position.y = -gl_Position.y;
                
                v_alpha = 1.0 - (a_age / u_particleAge);
                gl_PointSize = 2.0;
            }
        `;

        // 粒子片段着色器
        const particleFragmentShader = `
            precision mediump float;
            
            uniform vec3 u_color;
            uniform float u_globalAlpha;
            
            varying float v_alpha;
            
            void main() {
                gl_FragColor = vec4(u_color, v_alpha * u_globalAlpha);
            }
        `;

        // 箭头顶点着色器
        const arrowVertexShader = `
            attribute vec2 a_position;
            
            uniform vec2 u_resolution;
            uniform mat3 u_transform;
            
            void main() {
                vec3 pos = u_transform * vec3(a_position, 1.0);
                gl_Position = vec4((pos.xy / u_resolution) * 2.0 - 1.0, 0.0, 1.0);
                gl_Position.y = -gl_Position.y;
            }
        `;

        // 箭头片段着色器
        const arrowFragmentShader = `
            precision mediump float;
            
            uniform vec3 u_color;
            uniform float u_alpha;
            
            void main() {
                gl_FragColor = vec4(u_color, u_alpha);
            }
        `;

        this.particleProgram = this._createProgram(particleVertexShader, particleFragmentShader);
        this.arrowProgram = this._createProgram(arrowVertexShader, arrowFragmentShader);
    }

    _createProgram(vertexSource, fragmentSource) {
        const vertexShader = this._createShader(this.gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this._createShader(this.gl.FRAGMENT_SHADER, fragmentSource);
        
        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);
        
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            throw new Error('Program link error: ' + this.gl.getProgramInfoLog(program));
        }
        
        return program;
    }

    _createShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            throw new Error('Shader compile error: ' + this.gl.getShaderInfoLog(shader));
        }
        
        return shader;
    }

    _initParticles() {
        this.particles = [];
        for (let i = 0; i < this.particleCount; i++) {
            this.particles.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                vx: 0,
                vy: 0,
                age: Math.random() * this.options.particleAge
            });
        }
    }

    setData(data) {
        this.windData = data;
        this._processWindData();
    }

    _processWindData() {
        if (!this.windData || this.windData.length < 2) return;
        
        const uData = this.windData[0].data;
        const vData = this.windData[1].data;
        const header = this.windData[0].header;
        
        this.windGrid = {
            data: { u: uData, v: vData },
            width: header.nx,
            height: header.ny,
            startLon: header.lo1,
            startLat: header.la1,
            scale: header.d
        };
    }

    _getWindAt(x, y) {
        if (!this.windGrid) return {u: 0, v: 0};
        
        // 将屏幕坐标转换为地理坐标，然后转换为网格索引
        // 这里需要根据具体的地图投影进行转换
        const gridX = Math.floor(x / this.canvas.width * this.windGrid.width);
        const gridY = Math.floor(y / this.canvas.height * this.windGrid.height);
        
        if (gridX < 0 || gridX >= this.windGrid.width || gridY < 0 || gridY >= this.windGrid.height) {
            return {u: 0, v: 0};
        }
        
        const index = gridY * this.windGrid.width + gridX;
        return {
            u: this.windGrid.data.u[index] || 0,
            v: this.windGrid.data.v[index] || 0
        };
    }

    render() {
        const currentTime = Date.now();
        if (currentTime - this.lastFrameTime < this.frameRate) return;
        this.lastFrameTime = currentTime;
        
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        
        if (this.options.particle) {
            this._renderParticles();
        }
    }

    _renderParticles() {
        // 更新粒子位置
        this.particles.forEach(particle => {
            const wind = this._getWindAt(particle.x, particle.y);
            particle.vx = wind.u * this.options.velocityScale;
            particle.vy = wind.v * this.options.velocityScale;
            
            particle.x += particle.vx;
            particle.y += particle.vy;
            particle.age++;
            
            // 重置超出边界或生命周期结束的粒子
            if (particle.x < 0 || particle.x > this.canvas.width || 
                particle.y < 0 || particle.y > this.canvas.height || 
                particle.age > this.options.particleAge) {
                particle.x = Math.random() * this.canvas.width;
                particle.y = Math.random() * this.canvas.height;
                particle.age = 0;
            }
        });

        // 渲染粒子
        this.gl.useProgram(this.particleProgram);
        
        // 创建位置缓冲区
        const positions = new Float32Array(this.particles.length * 2);
        const ages = new Float32Array(this.particles.length);
        
        this.particles.forEach((particle, i) => {
            positions[i * 2] = particle.x;
            positions[i * 2 + 1] = particle.y;
            ages[i] = particle.age;
        });
        
        // 位置属性
        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.DYNAMIC_DRAW);
        
        const positionLocation = this.gl.getAttribLocation(this.particleProgram, 'a_position');
        this.gl.enableVertexAttribArray(positionLocation);
        this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, 0, 0);
        
        // 年龄属性
        const ageBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, ageBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, ages, this.gl.DYNAMIC_DRAW);
        
        const ageLocation = this.gl.getAttribLocation(this.particleProgram, 'a_age');
        this.gl.enableVertexAttribArray(ageLocation);
        this.gl.vertexAttribPointer(ageLocation, 1, this.gl.FLOAT, false, 0, 0);
        
        // 设置uniform
        const resolutionLocation = this.gl.getUniformLocation(this.particleProgram, 'u_resolution');
        this.gl.uniform2f(resolutionLocation, this.canvas.width, this.canvas.height);
        
        const colorLocation = this.gl.getUniformLocation(this.particleProgram, 'u_color');
        const color = this._parseColor(this.options.color[0]);
        this.gl.uniform3f(colorLocation, color.r, color.g, color.b);
        
        const alphaLocation = this.gl.getUniformLocation(this.particleProgram, 'u_globalAlpha');
        this.gl.uniform1f(alphaLocation, this.options.globalAlpha);
        
        const particleAgeLocation = this.gl.getUniformLocation(this.particleProgram, 'u_particleAge');
        this.gl.uniform1f(particleAgeLocation, this.options.particleAge);
        
        this.gl.drawArrays(this.gl.POINTS, 0, this.particles.length);
    }

    drawArrows() {
        // 箭头绘制实现
        if (!this.windGrid) return;
        
        this.gl.useProgram(this.arrowProgram);
        
        // 简化的箭头绘制逻辑
        const arrowSpacing = 50;
        const arrows = [];
        
        for (let x = 0; x < this.canvas.width; x += arrowSpacing) {
            for (let y = 0; y < this.canvas.height; y += arrowSpacing) {
                const wind = this._getWindAt(x, y);
                if (Math.abs(wind.u) > 0.01 || Math.abs(wind.v) > 0.01) {
                    arrows.push({x, y, u: wind.u, v: wind.v});
                }
            }
        }
        
        // 绘制箭头的具体实现
        // ...
    }

    _parseColor(colorStr) {
        const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
            return {
                r: parseInt(match[1]) / 255,
                g: parseInt(match[2]) / 255,
                b: parseInt(match[3]) / 255
            };
        }
        return {r: 1, g: 1, b: 1};
    }

    start(canvasSize, bounds) {
        this.canvas.width = canvasSize.width;
        this.canvas.height = canvasSize.height;
        this.bounds = bounds;
    }

    stop() {
        // 停止渲染
    }

    clear() {
        if (this.gl) {
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        }
    }

    clearCanvas() {
        this.clear();
    }

    setAreaRatio(ratio) {
        this.areaRatio = ratio;
    }

    setMagnification(mag) {
        this.magnification = mag;
    }

    setColor(color) {
        this.options.color = color;
    }

    setVelocityScale(scale) {
        this.options.velocityScale = scale;
    }

    setGlobalAlpha(alpha) {
        this.options.globalAlpha = alpha;
    }

    setParticleAge(age) {
        this.options.particleAge = age;
    }

    setParticleCount(count) {
        this.particleCount = count;
        this._initParticles();
    }

    setFrameRate(rate) {
        this.frameRate = 1000 / rate;
    }

    setLineWidth(width) {
        this.options.lineWidth = width;
    }

    dispose() {
        if (this.gl) {
            this.gl.deleteProgram(this.particleProgram);
            this.gl.deleteProgram(this.arrowProgram);
        }
    }
}
}