import windImg1 from '../img/wind/1.png'
import windImg2 from '../img/wind/2.png'
import windImg3 from '../img/wind/3.png'
import windImg4 from '../img/wind/4.png'
import windImg5 from '../img/wind/5.png'
import windImg6 from '../img/wind/6.png'
import windImg7 from '../img/wind/7.png'
import windImg8 from '../img/wind/8.png'
import windImg9 from '../img/wind/9.png'
import windImg10 from '../img/wind/10.png'
import windImg11 from '../img/wind/11.png'
import windImg12 from '../img/wind/12.png'
import windImg13 from '../img/wind/13.png'
import windImg14 from '../img/wind/14.png'
import windImg15 from '../img/wind/15.png'
export function createCanvasWindFeatherLayer(leaflet) {
    const CanvasWindFeatherLayer = leaflet.Layer.extend({
        includes: leaflet.Mixin.Events,
        options: {
            oceanData: null, // 海洋UV数据
            zIndex: 20,
            scale: 0.22,
            startLongitude: 0,
            endLongitude: 360,
            startLatitude: 90,
            endLatitude: -90,
            // 【新增】颜色配置选项
            // color: 可以是 null, string, 或者 array.
            // null: 使用默认的基于风向的HSL色盘.
            // string: e.g., 'rgb(220, 81, 81)' or 'white', 用于渲染所有风向杆的单色.
            // array: 一个 colorBar 数组，用于根据 colorProperty 的值进行颜色插值.
            color: null,
            // 【新增】用于颜色映射的属性
            // 'direction' (默认) 或 'speed'. 决定当 color 是一个数组时，使用哪个属性来匹配 colorBar.
            colorProperty: 'direction',
        },

        // 设置海洋数据
        setOceanData: function(oceanData) {
            this.options.oceanData = oceanData;
            this._resetCanvas();
        },

        // 重置画布
        _resetCanvas: function() {
            const container = this._container;
            const canvas = this._canvas;
            const mapSize = this._map.getSize();
            const containerPoint = this._map.containerPointToLayerPoint([0, 0]);

            leaflet.DomUtil.setPosition(container, containerPoint);
            container.style.width = mapSize.x + "px";
            container.style.height = mapSize.y + "px";
            canvas.width = mapSize.x;
            canvas.height = mapSize.y;
            canvas.style.width = mapSize.x + "px";
            canvas.style.height = mapSize.y + "px";

            this._drawWindFeathers();
        },
        getContainer: function (){
            return this._container;
        },
        // 绘制风向杆
        _drawWindFeathers: function() {
            const canvas = this._canvas;
            const map = this._map;

            console.log("=== 开始绘制风向杆调试 ===");
            console.log("Canvas尺寸:", canvas.width, "x", canvas.height);
            console.log("地图缩放级别:", map.getZoom());
            console.log("地图边界:", map.getBounds());

            if (!this.options.oceanData || !this.options.oceanData.data) {
                console.error("❌ 海洋数据为空");
                return;
            }

            const uData = this.options.oceanData.data[0];
            const vData = this.options.oceanData.data[1];

            if (!uData || !vData) {
                console.error("❌ UV数据为空");
                return;
            }

            // console.log("✅ 数据网格大小:", uData.length);
            console.log("✅ 数据样本:", {
                u: uData[0] ? uData[0][0] : 'undefined',
                v: vData[0] ? vData[0][0] : 'undefined'
            });

            if (leaflet.Browser.canvas && map) {
                const context = canvas.getContext("2d");
                context.clearRect(0, 0, canvas.width, canvas.height);

                this.drawingId = this._generateId();
                const currentDrawingId = this.drawingId;

                this.currentZoom = map.getZoom();
                this.currentBounds = map.getBounds();
                this.northWest = this.currentBounds.getNorthWest();
                this.southEast = this.currentBounds.getSouthEast();
                this.tileRange = this._getTileRange(this.northWest, this.southEast, this.currentZoom);

                console.log("瓦片范围:", this.tileRange);

                const gridSize = uData.length;
                const latitudeStep = (this.options.startLatitude - this.options.endLatitude) / gridSize;
                const longitudeStep = (this.options.endLongitude - this.options.startLongitude) / gridSize;

                console.log("网格步长:", {
                    latitudeStep,
                    longitudeStep
                });

                const zoomLevel = this.currentZoom;
                const tilesPerSide = Math.pow(2, zoomLevel);

                let totalSamples = 0;
                let validDataCount = 0;
                let drawnFeathers = 0;

                // 遍历瓦片范围
                for (let tileRow = this.tileRange.top; tileRow <= this.tileRange.bottom; tileRow++) {
                    for (let tileCol = this.tileRange.left; tileCol <= this.tileRange.right; tileCol++) {
                        let worldTileX = Math.floor(tileCol / tilesPerSide);
                        let normalizedTileX = tileCol % tilesPerSide;

                        if (normalizedTileX < 0) {
                            normalizedTileX = normalizedTileX + tilesPerSide;
                        }

                        const worldTileY = tileRow;
                        const tileX = normalizedTileX;
                        const pixelSize = 2 * Math.PI / (256 * Math.pow(2, zoomLevel));
                        const tileWestLon = tileX * pixelSize * 256 - Math.PI + pixelSize / 2;
                        const tileNorthLat = Math.PI - worldTileY * pixelSize * 256 - pixelSize / 2;

                        const samplesPerTile = 8;
                        const sampleStep = 256 / samplesPerTile;

                        // 在瓦片内采样
                        for (let sampleY = 0; sampleY < samplesPerTile; sampleY++) {
                            for (let sampleX = 0; sampleX < samplesPerTile; sampleX++) {
                                totalSamples++;

                                const pixelCoords = this._getLatLonFromPixel(
                                    tileWestLon, tileNorthLat, pixelSize,
                                    sampleX * sampleStep, sampleY * sampleStep
                                );

                                let longitude = pixelCoords.longitude;
                                const latitude = pixelCoords.latitude;

                                // 经度标准化
                                longitude = longitude % 360;
                                if (longitude < 0) {
                                    longitude = longitude + 360;
                                }

                                // 检查边界条件
                                if (latitude > this.options.startLatitude ||
                                    latitude < this.options.endLatitude ||
                                    longitude < this.options.startLongitude ||
                                    longitude > this.options.endLongitude) {
                                    continue;
                                }

                                // 计算网格索引
                                const latIndex = Math.floor((this.options.startLatitude - latitude) / latitudeStep);
                                const lonIndex = Math.floor((longitude - this.options.startLongitude) / longitudeStep);

                                // 边界检查
                                if (latIndex < 0 || latIndex >= gridSize || lonIndex < 0 || lonIndex >= gridSize) {
                                    continue;
                                }

                                // 获取UV数据
                                if (!uData[latIndex] || !uData[latIndex][lonIndex] ||
                                    !vData[latIndex] || !vData[latIndex][lonIndex]) {
                                    continue;
                                }

                                const uComponent = uData[latIndex][lonIndex];
                                const vComponent = vData[latIndex][lonIndex];

                                // 跳过无效数据
                                if (uComponent === 0 && vComponent === 0) {
                                    continue;
                                }

                                validDataCount++;

                                // 计算实际经度（考虑世界偏移）
                                const actualLongitude = pixelCoords.longitude + 360 * worldTileX;

                                // 转换为屏幕坐标
                                const screenPoint = map.latLngToContainerPoint(
                                    leaflet.latLng(latitude, actualLongitude)
                                );

                                // 检查屏幕坐标是否在可见范围内
                                if (screenPoint.x < 0 || screenPoint.x > canvas.width ||
                                    screenPoint.y < 0 || screenPoint.y > canvas.height) {
                                    continue;
                                }

                                const windVector = this._calculateWindVector(uComponent, vComponent);
                                const windSpeed = windVector.speed;
                                const windAngle = windVector.angle;

                                // 【修改】根据 options.color 决定颜色
                                const windLevel = this._getWindLevel(windSpeed);
                                let windColor;

                                if (Array.isArray(this.options.color) && this.options.color.length > 0) {
                                    // 模式一：使用 colorBar 数组
                                    const valueToMap = this.options.colorProperty === 'speed' ? windSpeed : windAngle;
                                    windColor = this._getColorFromColorBar(valueToMap, this.options.color);
                                } else if (typeof this.options.color === 'string') {
                                    // 模式二：使用指定的单色
                                    windColor = this._parseRgb(this.options.color);
                                } else {
                                    // 默认/回退行为：使用基于风向的 HSL 颜色映射
                                    windColor = this._getWindDirectionColor(windAngle);
                                }


                                // 调试前几个点的详细信息
                                if (drawnFeathers < 5) {
                                    console.log(`风向杆 ${drawnFeathers + 1}:`, {
                                        position: {
                                            lat: latitude,
                                            lng: actualLongitude
                                        },
                                        screen: {
                                            x: screenPoint.x,
                                            y: screenPoint.y
                                        },
                                        wind: {
                                            speed: windSpeed,
                                            angle: windAngle
                                        },
                                        uv: {
                                            u: uComponent,
                                            v: vComponent
                                        }
                                    });
                                }

                                // 绘制风向杆
                                this._drawWindFeather(
                                    context, screenPoint.x, screenPoint.y,
                                    this.options.scale, windAngle, windColor,
                                    windLevel, currentDrawingId
                                );

                                drawnFeathers++;
                            }
                        }
                    }
                }

                console.log("绘制统计:", {
                    totalSamples,
                    validDataCount,
                    drawnFeathers,
                    samplingRate: `${((validDataCount / totalSamples) * 100).toFixed(2)}%`
                });

                if (drawnFeathers === 0) {
                    console.error("❌ 没有绘制任何风向杆！");
                    console.log("可能的问题:");
                    console.log("1. 数据范围与地图视野不匹配");
                    console.log("2. 所有数据点都是0值");
                    console.log("3. 屏幕坐标计算错误");
                    console.log("4. 图片加载失败");
                }
            }
        },

        // 绘制单个风向杆 - 添加颜色滤镜
        _drawWindFeather: function(context, x, y, scale, angle, color, level, drawingId) {
            if (!color) {
                console.warn(`无效的颜色值，跳过在 (${x}, ${y}) 的绘制`);
                return;
            }
            // console.log(`尝试绘制风向杆: 位置(${x}, ${y}), 等级${level}, 角度${angle}, 颜色RGB(${color.r}, ${color.g}, ${color.b})`);

            const windImage = new Image();

            const windImages = {
                1: windImg1,
                2:windImg2 ,
                3:windImg3 ,
                4: windImg4,
                5:windImg5 ,
                6:windImg6,
                7:windImg7 ,
                8:windImg8,
                9:windImg9 ,
                10: windImg10,
                11:windImg11,
                12: windImg12,
                13: windImg13,
                14:windImg14,
                15: windImg15
            };

            if (!windImages[level]) {
                console.warn(`❌ 风向杆等级 ${level} 的图片不存在，使用默认等级 1`);
            }

            windImage.src = windImages[level] || windImages[1];
            // console.log(`图片路径: ${windImage.src}`);

            // 添加图片加载错误处理
            windImage.onerror = () => {
                console.error(`❌ 图片加载失败: ${windImage.src}`);
                // 尝试绘制一个简单的箭头作为替代
                context.save();
                context.translate(x, y);
                context.rotate(angle * Math.PI / 180);
                context.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
                context.lineWidth = 2;
                context.beginPath();
                context.moveTo(0, -10);
                context.lineTo(0, 10);
                context.moveTo(-5, -5);
                context.lineTo(0, -10);
                context.lineTo(5, -5);
                context.stroke();
                context.restore();
                console.log(`✅ 绘制了替代箭头在位置 (${x}, ${y})`);
            };

            windImage.onload = () => {
                // console.log(`✅ 图片加载成功: ${windImage.src}`);

                // 检查绘制ID是否还有效
                if (drawingId !== this.drawingId) {
                    console.log("⚠️ 绘制ID已过期，跳过绘制");
                    return;
                }

                context.save();

                const imageWidth = windImage.width * scale;
                const imageHeight = windImage.height * scale;

                // console.log(`绘制图片尺寸: ${imageWidth} x ${imageHeight}`);

                // 移动到绘制位置并旋转
                context.translate(x, y);
                context.rotate(angle * Math.PI / 180);

                // 应用颜色滤镜
                // 先绘制到临时画布上进行颜色处理
                const tempCanvas = document.createElement('canvas');
                const tempContext = tempCanvas.getContext('2d');
                tempCanvas.width = imageWidth;
                tempCanvas.height = imageHeight;

                // 绘制原始图像
                tempContext.drawImage(windImage, 0, 0, imageWidth, imageHeight);

                // 获取图像数据并应用颜色滤镜
                const imageData = tempContext.getImageData(0, 0, imageWidth, imageHeight);
                const data = imageData.data;

                for (let i = 0; i < data.length; i += 4) {
                    // 如果像素不透明
                    if (data[i + 3] > 0) {
                        // 直接替换为目标颜色，保持原始alpha
                        data[i] = color.r; // Red
                        data[i + 1] = color.g; // Green  
                        data[i + 2] = color.b; // Blue
                        // Alpha 保持不变
                    }
                }

                // 将处理后的图像数据放回临时画布
                tempContext.putImageData(imageData, 0, 0);

                // 绘制处理后的图像到主画布
                context.drawImage(tempCanvas, -imageWidth / 2, -imageHeight / 2);

                context.restore();
                // console.log(`✅ 风向杆绘制完成在位置 (${x}, ${y})，颜色 RGB(${color.r}, ${color.g}, ${color.b})`);
            };
        },

        // 【新增】从 colorBar 中通过线性插值获取颜色
        _getColorFromColorBar: function(value, colorBars) {
            if (!colorBars || colorBars.length === 0) {
                return this._parseRgb('white'); // 如果 colorBar 无效，返回白色
            }

            // 确保 colorBars 按 value 排序
            const sortedBars = colorBars.slice().sort((a, b) => a.value - b.value);

            // 如果值小于最小值，使用第一个颜色
            if (value <= sortedBars[0].value) {
                return this._parseRgb(sortedBars[0].color);
            }

            // 如果值大于最大值，使用最后一个颜色
            if (value >= sortedBars[sortedBars.length - 1].value) {
                return this._parseRgb(sortedBars[sortedBars.length - 1].color);
            }

            // 找到值所在区间的起始和结束颜色
            let startBar, endBar;
            for (let i = 0; i < sortedBars.length - 1; i++) {
                if (value >= sortedBars[i].value && value <= sortedBars[i + 1].value) {
                    startBar = sortedBars[i];
                    endBar = sortedBars[i + 1];
                    break;
                }
            }

            if (!startBar) {
                return this._parseRgb(sortedBars[sortedBars.length - 1].color);
            }

            // 在两个颜色之间进行插值
            const startColor = this._parseRgb(startBar.color);
            const endColor = this._parseRgb(endBar.color);
            const range = endBar.value - startBar.value;
            const ratio = (range === 0) ? 1 : (value - startBar.value) / range;

            const r = Math.round(startColor.r + (endColor.r - startColor.r) * ratio);
            const g = Math.round(startColor.g + (endColor.g - startColor.g) * ratio);
            const b = Math.round(startColor.b + (endColor.b - startColor.b) * ratio);

            return {
                r,
                g,
                b
            };
        },

        // 【新增】解析颜色字符串 (e.g., "rgb(255, 255, 255)") 为对象
        _parseRgb: function(colorString) {
            if (typeof colorString !== 'string') return {
                r: 255,
                g: 255,
                b: 255
            };
            const rgbMatch = colorString.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
            if (rgbMatch) {
                return {
                    r: parseInt(rgbMatch[1], 10),
                    g: parseInt(rgbMatch[2], 10),
                    b: parseInt(rgbMatch[3], 10)
                };
            }
            // 简单支持颜色名
            if (colorString.toLowerCase() === 'white') return {
                r: 255,
                g: 255,
                b: 255
            };
            if (colorString.toLowerCase() === 'black') return {
                r: 0,
                g: 0,
                b: 0
            };
            // 默认返回白色
            return {
                r: 255,
                g: 255,
                b: 255
            };
        },

        // 【保留】基于风向的颜色映射 (默认行为)
        _getWindDirectionColor: function(angle) {
            // 使用HSL颜色空间，根据角度映射颜色
            // 0°(北) = 蓝色(240°), 90°(东) = 绿色(120°), 180°(南) = 红色(0°), 270°(西) = 黄色(60°)
            let hue;
            if (angle >= 0 && angle < 90) {
                // 北到东: 蓝色到绿色 (240° 到 120°)
                hue = 240 - (angle / 90) * 120;
            } else if (angle >= 90 && angle < 180) {
                // 东到南: 绿色到红色 (120° 到 0°)
                hue = 120 - ((angle - 90) / 90) * 120;
            } else if (angle >= 180 && angle < 270) {
                // 南到西: 红色到黄色 (0° 到 60°)
                hue = ((angle - 180) / 90) * 60;
            } else {
                // 西到北: 黄色到蓝色 (60° 到 240°)
                hue = 60 + ((angle - 270) / 90) * 180;
            }

            // 使用较高的饱和度和适中的亮度
            return this._hslToRgb(hue, 80, 60);
        },

        // HSL到RGB转换
        _hslToRgb: function(h, s, l) {
            h = h % 360;
            s /= 100;
            l /= 100;

            const c = (1 - Math.abs(2 * l - 1)) * s;
            const x = c * (1 - Math.abs((h / 60) % 2 - 1));
            const m = l - c / 2;

            let r, g, b;

            if (h >= 0 && h < 60) {
                r = c;
                g = x;
                b = 0;
            } else if (h >= 60 && h < 120) {
                r = x;
                g = c;
                b = 0;
            } else if (h >= 120 && h < 180) {
                r = 0;
                g = c;
                b = x;
            } else if (h >= 180 && h < 240) {
                r = 0;
                g = x;
                b = c;
            } else if (h >= 240 && h < 300) {
                r = x;
                g = 0;
                b = c;
            } else {
                r = c;
                g = 0;
                b = x;
            }

            return {
                r: Math.round((r + m) * 255),
                g: Math.round((g + m) * 255),
                b: Math.round((b + m) * 255)
            };
        },

        // 使用正确的风向计算方法
        _calculateWindVector: function(uComponent, vComponent) {
            const speed = Math.sqrt(uComponent * uComponent + vComponent * vComponent);

            // θ = (270 - atan2(v, u) * 180 / π + 360) % 360
            const rad = Math.atan2(vComponent, uComponent);
            const angle = (270 - rad * 180 / Math.PI + 360) % 360;

            return {
                speed,
                angle
            };
        },

        // 清空画布
        _clearCanvas: function() {
            const canvas = this._canvas;
            try {
                canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
            } catch (error) {
                console.warn('清空画布失败:', error);
            }
        },

        // 设置图层层级
        setZIndex: function(zIndex) {
            this._container.style.zIndex = zIndex;
        },

        // 初始化
        initialize: function(options) {
            leaflet.setOptions(this, options);
            this.currentBounds = null;
            this.currentZoom = null;
        },

        // 添加到地图
        // 添加到地图 (REPLACE THIS ENTIRE FUNCTION)
        onAdd: function(map) {
            this._map = map;

            // This if block should only initialize the canvas, not add it to a pane.
            if (!this._container) {
                this._initCanvas();
            }

            // This logic MUST be outside the if block to work correctly when toggling layers.
            const targetPane = this.options.pane ? map.getPane(this.options.pane) : map.getPanes().overlayPane;

            // This is the SAFE and ONLY place we add the container to the map.
            if (targetPane) {
                targetPane.appendChild(this._container);
            } else {
                console.error(`FATAL: The pane "${this.options.pane}" does not exist on the map. The layer cannot be displayed.`);
                // If the pane doesn't exist, we stop here to prevent a crash.
                return; 
            }
            
            // 绑定地图事件
            map.on("zoomstart", this._clearCanvas, this);
            map.on("moveend", this._resetCanvas, this);
            if (map.options.zoomAnimation && leaflet.Browser.any3d) {
                map.on("zoomanim", this._animateZoom, this);
            }

            this._resetCanvas();
        },

        // 从地图移除
    onRemove: function(map) {
        // 1. ✅ 核心修正：
        //    不再写死从哪个 Pane 移除。
        //    而是检查 _container 是否有父节点，如果有，就从父节点中移除自己。
        if (this._container && this._container.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }

        // 2. 解绑所有地图事件
        map.off("zoomstart", this._clearCanvas, this);
        map.off("moveend", this._resetCanvas, this);
        if (map.options.zoomAnimation) {
            map.off("zoomanim", this._animateZoom, this);
        }
    },

        // 添加到地图的便捷方法
        addTo: function(map) {
            map.addLayer(this);
            return this;
        },

        // 置于底层
        bringToBack: function() {
            const overlayPane = this._map._panes.overlayPane;
            if (this._canvas && overlayPane.firstChild) {
                overlayPane.insertBefore(this._canvas, overlayPane.firstChild);
            }
            return this;
        },

        // 初始化画布
        _initCanvas: function() {
            this._container = leaflet.DomUtil.create("div", "leaflet-image-layer");
            this._canvas = leaflet.DomUtil.create("canvas", "");
            this._canvas.style.pointerEvents = "none";
            this.setZIndex(this.options.zIndex);

            if (this._map.options.zoomAnimation && leaflet.Browser.any3d) {
                leaflet.DomUtil.addClass(this._canvas, "leaflet-zoom-animated");
            } else {
                leaflet.DomUtil.addClass(this._canvas, "leaflet-zoom-hide");
            }

            this._container.appendChild(this._canvas);

            leaflet.extend(this._canvas, {
                onselectstart: leaflet.Util.falseFn,
                onmousemove: leaflet.Util.falseFn,
                onload: leaflet.bind(this._onCanvasLoad, this)
            });
        },

        // 缩放动画
        _animateZoom: function(event) {
            const map = this._map;
            const canvas = this._canvas;
            const scale = map.getZoomScale(event.zoom);
            const topLeft = map.containerPointToLatLng([0, 0]);
            const bottomRight = map.containerPointToLatLng([canvas.width, canvas.height]);
            const newTopLeft = map._latLngToNewLayerPoint(topLeft, event.zoom, event.center);
            const newSize = map._latLngToNewLayerPoint(bottomRight, event.zoom, event.center)._subtract(newTopLeft);

            newTopLeft._add(newSize._multiplyBy(1 / 2 * (1 - 1 / scale)));
        },

        // 画布加载完成
        _onCanvasLoad: function() {
            this.fire("load");
        },

        // 根据风速选择风向杆等级
        _getWindLevel: function(windSpeed) {
            if (windSpeed >= 0 && windSpeed <= 2) return 1;
            if (windSpeed > 2 && windSpeed <= 4) return 2;
            if (windSpeed > 4 && windSpeed <= 6) return 3;
            if (windSpeed > 6 && windSpeed <= 8) return 4;
            if (windSpeed > 8 && windSpeed <= 10) return 5;
            if (windSpeed > 10 && windSpeed <= 12) return 6;
            if (windSpeed > 12 && windSpeed <= 14) return 7;
            if (windSpeed > 14 && windSpeed <= 16) return 8;
            if (windSpeed > 16 && windSpeed <= 18) return 9;
            if (windSpeed > 18 && windSpeed <= 20) return 10;
            if (windSpeed > 20 && windSpeed <= 24) return 11;
            if (windSpeed > 24 && windSpeed <= 28) return 12;
            if (windSpeed > 28 && windSpeed <= 32) return 13;
            if (windSpeed > 32 && windSpeed <= 36) return 14;
            return 15; // > 36
        },

        // 生成随机ID
        _generateId: function() {
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            let result = "";
            for (let i = 0; i < 5; i++) {
                result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
        },

        // 从像素坐标获取经纬度
        _getLatLonFromPixel: function(westLon, northLat, pixelSize, pixelX, pixelY) {
            const longitude = (westLon + pixelX * pixelSize) / Math.PI * 180;
            const latitude = 180 / Math.PI * (2 * Math.atan(Math.exp((northLat - pixelY * pixelSize) / Math.PI * 180 * Math.PI / 180)) - Math.PI / 2);
            return {
                longitude,
                latitude
            };
        },

        // 获取瓦片范围
        _getTileRange: function(northWest, southEast, zoomLevel) {
            const topLeft = this._getCornerTileNumber(northWest.lat, northWest.lng, zoomLevel);
            const bottomRight = this._getCornerTileNumber(southEast.lat, southEast.lng, zoomLevel);

            return {
                left: topLeft.colNum === 0 ? topLeft.colNum : topLeft.colNum - 1,
                top: topLeft.rowNum === 0 ? topLeft.rowNum : topLeft.rowNum - 1,
                right: bottomRight.colNum,
                bottom: bottomRight.rowNum
            };
        },

        // 获取瓦片编号
        _getCornerTileNumber: function(latitude, longitude, zoomLevel) {
            const radianFactor = Math.PI / 180;
            const lonRadian = longitude * radianFactor;
            const latRadian = Math.log(Math.tan((90 + latitude) * Math.PI / 360)) / (Math.PI / 180) * Math.PI / 180;

            const tilesPerSide = Math.pow(2, zoomLevel);
            const rowNum = (Math.PI - latRadian) / (2 * Math.PI) * tilesPerSide;
            const colNum = (lonRadian + Math.PI) / (2 * Math.PI) * tilesPerSide;

            return {
                rowNum: Math.round(rowNum),
                colNum: Math.round(colNum)
            };
        }
    });

    // 工厂函数
    leaflet.canvasWindFeatherLayer = function(options) {
        return new CanvasWindFeatherLayer(options);
    };

    return CanvasWindFeatherLayer;
}
