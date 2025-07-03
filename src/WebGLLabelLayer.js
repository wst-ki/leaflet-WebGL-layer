/**
 * Scalar Label Layer for Leaflet
 *
 * This layer is responsible only for drawing text labels on a canvas overlay,
 * based on a grid data source. It is designed to be a lightweight companion
 * to a raster rendering layer like WebGLScalarLayer.
 *
 * It does not perform any WebGL rendering.
 */
export function createWebGLLabelLayer(L) {

    L.ScalarLabelLayer = L.Layer.extend({
        // Default options
        options: {
            zIndex: 10,         // Labels should typically be on top
            showLabel: true,    // Default to true for a label layer
            digit: 1,           // Number of decimal places for the label
            maxLabels: 300,     // Maximum number of labels to draw
            labelDensity: 1.5,  // Density factor (larger value means sparser labels)
            fontSize: 12,       // Font size in pixels
            fontColor: 'black', // Color of the label text
            haloColor: 'white', // Color of the text halo (outline)
            haloWidth: 2.5      // Width of the text halo
        },

        // Initialization
        initialize: function(options) {
            L.setOptions(this, options);
            this._map = null;
            this._canvas = null; // Only one canvas is needed for labels
            this._ctx = null;
            this.field = null;   // To hold the data and coordinate logic
            this.dataBounds = null;
        },

        // Set grid data
        setData: function(fieldParams) {
            if (!fieldParams || !fieldParams.grid) {
                console.error("Invalid data provided to ScalarLabelLayer");
                return;
            }

            // Create an internal field object for coordinate calculations
            this.field = {
                nCols: fieldParams.nCols,
                nRows: fieldParams.nRows,
                xllCorner: fieldParams.xllCorner,
                yllCorner: fieldParams.yllCorner,
                cellXSize: fieldParams.cellXSize,
                cellYSize: fieldParams.cellYSize,
                nodata: fieldParams.nodata || -9999,
                grid: fieldParams.grid,
                
                // Helper methods for coordinate conversion
                _lonLatAtIndexes: function(i, j) {
                    const yurCorner = this.yllCorner + this.nRows * this.cellYSize;
                    const lon = this.xllCorner + (i + 0.5) * this.cellXSize;
                    const lat = yurCorner - (j + 0.5) * this.cellYSize;
                    return [lon, lat];
                },
                
                _valueAtIndexes: function(i, j) {
                    const cj = Math.max(0, Math.min(this.nRows - 1, Math.floor(j)));
                    const ci = Math.max(0, Math.min(this.nCols - 1, Math.floor(i)));
                    if (this.grid && this.grid[cj]) {
                        return this.grid[cj][ci];
                    }
                    return this.nodata;
                }
            };

            // Calculate the geographical bounds from the data's metadata
            const yurCorner = this.field.yllCorner + this.field.nRows * this.field.cellYSize;
            const xurCorner = this.field.xllCorner + this.field.nCols * this.field.cellXSize;
            this.dataBounds = L.latLngBounds(
                L.latLng(this.field.yllCorner, this.field.xllCorner),
                L.latLng(yurCorner, xurCorner)
            );

            // If the layer is already on the map, trigger a redraw
            if (this._map) {
                this._resetCanvas();
            }
        },

        // Leaflet layer lifecycle methods
        onAdd: function(map) {
            this._map = map;
            this._initCanvas();
            
            // Add to the map pane
            map.getPanes().overlayPane.appendChild(this._canvas);
            
            // Listen to map events
            map.on('moveend', this._resetCanvas, this);
            map.on('zoomend', this._resetCanvas, this);
            
            this._resetCanvas();
        },

        onRemove: function(map) {
            if (this._canvas && this._canvas.parentNode) {
                this._canvas.parentNode.removeChild(this._canvas);
            }
            map.off('moveend', this._resetCanvas, this);
            map.off('zoomend', this._resetCanvas, this);
        },

        // Canvas management
        _initCanvas: function() {
            this._canvas = L.DomUtil.create('canvas', 'leaflet-scalar-label-layer');
            this._canvas.style.position = 'absolute';
            this._canvas.style.zIndex = this.options.zIndex;
            this._canvas.style.pointerEvents = 'none'; // Labels should not intercept mouse events
            this._ctx = this._canvas.getContext('2d');
        },

        _resetCanvas: function() {
            if (!this._map) return;
            
            const size = this._map.getSize();
            const topLeft = this._map.containerPointToLayerPoint([0, 0]);
            
            // Position the canvas
            L.DomUtil.setPosition(this._canvas, topLeft);

            // Adapt for high-DPI screens
            const pixelRatio = window.devicePixelRatio || 1;
            this._canvas.width = size.x * pixelRatio;
            this._canvas.height = size.y * pixelRatio;
            this._canvas.style.width = size.x + 'px';
            this._canvas.style.height = size.y + 'px';
            
            // Scale the context to draw sharp text
            this._ctx.scale(pixelRatio, pixelRatio);
            
            this._drawLabels();
        },

        // Main drawing function
        _drawLabels: function() {
            if (!this.options.showLabel || !this.field || !this._ctx || !this.dataBounds || !this.dataBounds.isValid()) {
                if (this._ctx) this._ctx.clearRect(0, 0, this._ctx.canvas.width, this._ctx.canvas.height);
                return;
            }

            const ctx = this._ctx;
            const mapBounds = this._map.getBounds();
            
            // Clear previous labels
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            
            // Calculate the intersection of the map view and the data bounds
            const intersection = this._calculateBoundsIntersection(mapBounds, this.dataBounds);
            if (!intersection) {
                return; // No data is visible, no need to draw
            }

            // Determine the appropriate sampling level (density)
            const dataTopLeft = this._map.latLngToContainerPoint(this.dataBounds.getNorthWest());
            const dataBottomRight = this._map.latLngToContainerPoint(this.dataBounds.getSouthEast());
            const dataPixelWidth = dataBottomRight.x - dataTopLeft.x;
            const pixelPerCellX = dataPixelWidth / this.field.nCols;
            const baseLabelSize = 75; // Target pixel distance between labels
            const aggLevel = Math.max(1, baseLabelSize / pixelPerCellX / (this.options.labelDensity || 1));

            // Determine the grid indices to iterate over based on the visible intersection
            const startI = Math.max(0, Math.floor((intersection.getWest() - this.field.xllCorner) / this.field.cellXSize));
            const endI = Math.min(this.field.nCols, Math.ceil((intersection.getEast() - this.field.xllCorner) / this.field.cellXSize));
            const startJ = Math.max(0, Math.floor((this.field.yllCorner + this.field.nRows * this.field.cellYSize - intersection.getNorth()) / this.field.cellYSize));
            const endJ = Math.min(this.field.nRows, Math.ceil((this.field.yllCorner + this.field.nRows * this.field.cellYSize - intersection.getSouth()) / this.field.cellYSize));

            // Setup text styling
            ctx.font = `${this.options.fontSize}px Arial`;
            ctx.fillStyle = this.options.fontColor;
            ctx.strokeStyle = this.options.haloColor;
            ctx.lineWidth = this.options.haloWidth;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            let labelCount = 0;
            
            // Iterate over the visible grid area with the calculated density
            for (let j = startJ; j < endJ && labelCount < this.options.maxLabels; j += aggLevel) {
                for (let i = startI; i < endI && labelCount < this.options.maxLabels; i += aggLevel) {
                    
                    const [lon, lat] = this.field._lonLatAtIndexes(i, j);
                    const val = this.field._valueAtIndexes(i, j);

                    if (val === this.field.nodata || isNaN(val)) continue;
                    
                    const point = this._map.latLngToContainerPoint(L.latLng(lat, lon));
                    const displayValue = val.toFixed(this.options.digit);
                    
                    // Draw halo first, then the text
                    ctx.strokeText(displayValue, point.x, point.y);
                    ctx.fillText(displayValue, point.x, point.y);

                    labelCount++;
                }
            }
        },
        
        // Helper method to calculate the intersection of two bounds
        _calculateBoundsIntersection: function(bounds1, bounds2) {
            const south = Math.max(bounds1.getSouth(), bounds2.getSouth());
            const west = Math.max(bounds1.getWest(), bounds2.getWest());
            const north = Math.min(bounds1.getNorth(), bounds2.getNorth());
            const east = Math.min(bounds1.getEast(), bounds2.getEast());
            
            if (west >= east || south >= north) {
                return null; // No intersection
            }
            
            return L.latLngBounds(L.latLng(south, west), L.latLng(north, east));
        },
        setZIndex: function(zIndex) {
            this.options.zIndex = zIndex;
            if (this._canvas) {
                this._canvas.style.zIndex = zIndex;
            }
        },
        // Public methods to control options
        setShowLabel: function(show) {
            this.options.showLabel = show;
            this._resetCanvas();
        },
        
        setLabelDensity: function(density) {
            this.options.labelDensity = Math.max(0.1, density);
            this._resetCanvas();
        }
    });

    // Factory function
    L.scalarLabelLayer = function(options) {
        return new L.ScalarLabelLayer(options);
    };
}
