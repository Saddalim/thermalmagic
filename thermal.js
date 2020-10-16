
const redrawTimeout = 14;
const referenceHeight = 670;

const defaultGroundTemperature = 25;
const defaultTemperatureGradient = 0.7; // [K/100m]
const calculationsMaxHeight = 10000;

const thermalInitialWidth = 30;
const thermalExpansionRatio = 0.65; // [%/1000m]

// Thermal impulse simulation
const thermalInitialImpulse = 1.8; // Multiplier for initial thermal strength (applied to current solar strength)
const thermalStagnantGradient = -0.39; // [K/100m] Temperature gradient at which thermal impulse is constant
const thermalImpulseTangentRatio = 0.4; // Ratio of how much thermal impulse change in function of deviation from stagnant gradient
const condensationCompensation = 0.38; // [1/100m] How much impulse to be lost when rising while condensing (in clouds)
const inversionCompensation = 2.5; // Multiplier to impulse loss in inversion layers

// Graphics
const grassHeight = 60;
const altimeterWidth = 60;
const cloudPuffMaxRadius = 35;
const windSliderExtreme = 10; // [m/s]
const tempSliderExtreme = 32; // [C]
const humiSliderExtreme = 15; // [g/m3]

// Tweakables
var maxShownAltitude = 6000; // [m]
var altimeterResolution = 2000; // [m]
var calculationResolution = 100; // [m]
var showTemperatureColoring = false;
var showTemperatureColoringHalf = false;
var temperatureColoringOpacity = 0.6;
var showFullWidthLines = false;
var showCloudBase = false;
var showHumidityColoring = false;
var showHumidityColoringHalf = false;
var humidityColoringOpacity = 0.6;
var groundPressure = 101325.0; // [Pa]
var defaultGroundAbsoluteHumidity = 10.0;
var showVario = false;
var solarStrength = 0.8;
var lockSolarToTemps = false;
var varioInterval = 500; // [m]
var showTempGraph = false;
// TODO dew point chart

var wrapperDiv;
var canvas;
var context;

var redrawTimer = null;
var spinnerRedrawTimer = null;

var weatherStack = [];

var displayScale = 1.0;
var userScale = 1.0;

// Temperature colorings
const minTemp = -10.0;
const maxBlue = 190;
const maxTemp = 37.0;
const maxRed = 255;

function roundToDecim(num, decim)
{
    return Math.round((num + Math.pow(10, -decim * 2)) * Math.pow(10, decim)) / Math.pow(10, decim);
}

function getRgbForTemp(temp)
{
    if (temp < minTemp) return {r: 0, g: 0, b: maxBlue};
    if (temp > maxTemp) return {r: maxRed, g: 0, b: 0};
    var maxTempDiff = maxTemp - minTemp;
    var red = ((temp - minTemp) * maxRed) / maxTempDiff;
    var blue = ((maxTemp - temp) * maxBlue) / maxTempDiff;
    return {r: Math.round(red), g: 0, b: Math.round(blue)};
}

// Humidity colorings

function getRgbForHumi(humi)
{
    if (humi < 0) return {r: 255, g: 255, b: 255};
    if (humi > 100) return {r: 0, g: 0, b: 255};
    return {r: 0, g: 0, b: Math.round((humi * 255) / 100)};
}

// =====================================================================================================================
// =====================================================================================================================
// Canvas scale calculations

function getScale()
{
    return userScale * displayScale;
}

function scale(x)
{
    return getScale() * x;
}

function s(x)
{
    return scale(x);
}

function getYOfAltitude(altitude)
{
    var drawHeight = canvas.height() - grassHeight;
    return drawHeight - ((altitude / maxShownAltitude) * drawHeight);
}

function stopSpinnerRedraw()
{
    if (spinnerRedrawTimer != null) clearInterval(spinnerRedrawTimer);
}

// =====================================================================================================================
// =====================================================================================================================
// Meteorological calculations

function getPressureAtAltitude(groundP, altitude, temperature)
{
    // Hypsometric formula - only below 10000m
    return groundP * Math.pow(1 - (0.0065 * altitude) / (temperature + 0.0065 * altitude + 273.15), 5.257);
}

function getSaturatedDensityFor(temperature)
{
    // Empirical fit to data table
    // http://hyperphysics.phy-astr.gsu.edu/hbase/Kinetic/relhum.html#c4
    return 5.018 + 0.32321 * temperature + 8.1847 * 0.001 * temperature * temperature + 3.1243 * 0.0001 * Math.pow(temperature, 3);
}

function getRelativeHumidity(absolute, altitude, pressure, temperature)
{
    return absolute / getSaturatedDensityFor(temperature);
}

function getDewPoint(temperature, relativeHumidity)
{
    // TODO this fails to calculate DP above ~6100m - and I have a feeling that the whole formula is bullshit...
    var H = ((Math.log(relativeHumidity * 100) / Math.log(10)) - 2) / 0.4343 + (17.62 * temperature) / (243.12 + temperature);
    return 243.12 * H / (17.62 - H);
}

// =====================================================================================================================
// =====================================================================================================================
// WeatherStack utilities

function MeteoData(altitude, temperature, wind, humidity)
{
    this.alt = altitude;
    this.temp = temperature;
    this.wind = wind;
    this.humidity = humidity;
    this.dewPoint = getDewPoint(temperature, getRelativeHumidity(humidity, altitude, getPressureAtAltitude(groundPressure, altitude, temperature), temperature));
}

function AutoMeteoData(altitude)
{
    this.alt = altitude;
    this.temp = getTemperatureAt(altitude);
    this.wind = getWindAt(altitude);
    this.humidity = getAbsoluteHumidityAt(altitude);
    this.dewPoint = getDewPointAt(altitude);
}

function getDataAt(altitude, fieldName)
{
    var below, above;
    for (var i = 0; i < weatherStack.length; ++i)
    {
        var curr = weatherStack[i];

        if (curr.alt === altitude)
        {
            return curr[fieldName];
        }
        else if (curr.alt < altitude)
        {
            below = curr;
        }
        else if (curr.alt > altitude)
        {
            above = curr;
            break;
        }
    }

    return below[fieldName] + ((altitude - below.alt) / (above.alt - below.alt)) * (above[fieldName] - below[fieldName]);
}

function setDataAt(altitude, fieldName, value)
{
    var below;
    for (var i = 0; i < weatherStack.length; ++i)
    {
        var curr = weatherStack[i];

        if (curr.alt === altitude)
        {
            curr[fieldName] = value;
            return;
        }
        else if (curr.alt < altitude)
        {
            below = i;
        }
        else if (curr.alt > altitude)
        {
            break;
        }
    }

    var newField = new AutoMeteoData(altitude);
    newField[fieldName] = value;
    weatherStack.splice(below, 0, newField);
}

function setTemperatureAt(altitude, temperature)
{
    return setDataAt(altitude, 'temp', temperature);
}

function getTemperatureAt(altitude)
{
    return getDataAt(altitude, 'temp');
}

function setWindAt(altitude, wind)
{
    return setDataAt(altitude, 'wind', wind);
}

function getWindAt(altitude)
{
    return getDataAt(altitude, 'wind');
}

function setAbsoluteHumidityAt(altitude, ah)
{
    return setDataAt(altitude, 'humidity', ah);
}

function getAbsoluteHumidityAt(altitude)
{
    return getDataAt(altitude, 'humidity');
}

function getDewPointAt(altitude)
{
    // TODO this is a very very rough estimation for dew point calculation. This should be done with a more precise
    // TODO calculation, taking LCL, CCL, LFC into account
    var temperature = getTemperatureAt(altitude);
    return getDewPoint(temperature, getRelativeHumidity(getAbsoluteHumidityAt(altitude), altitude, getPressureAtAltitude(groundPressure, altitude, temperature), temperature));
}

function getThermalData()
{
    // This is where we should calculate with dry and humid adiabat, mixing ratio, etc
    // So long that is not done, do a guesstimate with airmass impulse

    var data = {thermalTop: calculationsMaxHeight, cloudBase: calculationsMaxHeight, strength: []};

    var impulse = (solarStrength * 1.2 - 0.1) * thermalInitialImpulse;
    var prev = {alt: 0.0, temp: getTemperatureAt(0.0), relHumi: getRelativeHumidity(defaultGroundAbsoluteHumidity, 0.0, groundPressure, getTemperatureAt(0.0))};

    for (altitude = calculationResolution; altitude < calculationsMaxHeight; altitude += calculationResolution)
    {
        var temp = getTemperatureAt(altitude);
        var curr = {alt: altitude, temp: temp, relHumi: getRelativeHumidity(defaultGroundAbsoluteHumidity, altitude, getPressureAtAltitude(groundPressure, altitude, temp), temp)};
        var gradient = (curr.temp - prev.temp) * (calculationResolution / 100.0);

        if (curr.relHumi >= 1.0 && data.cloudBase === calculationsMaxHeight)
        {
            // just reached cloudbase
            data.cloudBase = prev.alt + ((1.0 - prev.relHumi) / (curr.relHumi - prev.relHumi)) * (curr.alt - prev.alt);
        }

        var compensationOffset = altitude < data.cloudBase ? 0.0 : (curr.alt - prev.alt) * (condensationCompensation / 100.0);
        var compensationMulti = gradient < 0.0 ? 1.0 : inversionCompensation;

        impulse += (thermalStagnantGradient - gradient) * thermalImpulseTangentRatio * compensationMulti - compensationOffset;

        data.strength.push({altitude: curr.alt, impulse: impulse});

        if (impulse < 0)
        {
            // thermal stopped
            // TODO interpolate thermalTop altitude
            data.thermalTop = altitude;
            break;
        }

        prev = curr;
    }

    return data;
}

// =====================================================================================================================
// =====================================================================================================================
// Drawing functions

function softRedraw()
{
    if (redrawTimer != null) clearTimeout(redrawTimer);
    redrawTimer = setTimeout(redrawCanvas, redrawTimeout);
}

function drawClouds(thermalData)
{
    var thermalPoints = [];
    var cloudPoints = [];

    var condensationLevel = {y: getYOfAltitude(Math.min(thermalData.cloudBase, thermalData.thermalTop)), x1: canvas.width() / 2, x2: canvas.width() / 2};

    var prevAlt = {alt: 0, y: 0, x1: canvas.width() / 2 - thermalInitialWidth / 2, x2: canvas.width() / 2 + thermalInitialWidth / 2};

    for (var altitude = 0; altitude <= maxShownAltitude && altitude <= thermalData.thermalTop; altitude += calculationResolution)
    {
        var wind = getWindAt(altitude);
        var x1, x2;
        if (wind > 0.0)
        {
            x1 = prevAlt.x1 + wind * 5.0;
            x2 = prevAlt.x2 + wind * 5.5;
        }
        else
        {
            x1 = prevAlt.x1 + wind * 5.5;
            x2 = prevAlt.x2 + wind * 5.0;
        }

        var data = {alt: altitude, y: getYOfAltitude(altitude), x1: x1, x2: x2};

        // Thermal expansion
        var expansionMultiplier = (calculationResolution / 1000.0) * thermalExpansionRatio;
        if (altitude > thermalData.cloudBase) expansionMultiplier *= 0.1;
        var thermalWidth = data.x2 - data.x1;
        data.x1 -= thermalWidth * (expansionMultiplier / 2.0);
        data.x2 += thermalWidth * (expansionMultiplier / 2.0);

        // Just passed condensation level
        if (thermalData.cloudBase > prevAlt.alt && thermalData.cloudBase < altitude)
        {
            condensationLevel.x1 = prevAlt.x1 + (data.x1 - prevAlt.x1) * ((thermalData.cloudBase - prevAlt.alt) / calculationResolution);
            condensationLevel.x2 = prevAlt.x2 + (data.x2 - prevAlt.x2) * ((thermalData.cloudBase - prevAlt.alt) / calculationResolution);
        }

        if (altitude < thermalData.cloudBase)
        {
            thermalPoints.push(data);
        }
        else
        {
            cloudPoints.push(data);
        }

        prevAlt = data;
    }

    // Thermal

    context.beginPath();
    context.moveTo(condensationLevel.x1, condensationLevel.y);

    var i;
    for (i = thermalPoints.length - 1; i >= 0; --i) context.lineTo(thermalPoints[i].x1, thermalPoints[i].y);
    for (i = 0; i < thermalPoints.length; ++i) context.lineTo(thermalPoints[i].x2, thermalPoints[i].y);

    context.lineTo(condensationLevel.x2, condensationLevel.y);
    context.closePath();

    context.fillStyle = "rgba(255, 127, 39, 0.5)";
    context.fill();

    // Cloud

    context.beginPath();
    context.moveTo(condensationLevel.x1, condensationLevel.y);

    for (i = 0; i < cloudPoints.length; ++i) context.lineTo(cloudPoints[i].x1, cloudPoints[i].y);
    for (i = cloudPoints.length - 1; i >= 0; --i) context.lineTo(cloudPoints[i].x2, cloudPoints[i].y);

    context.lineTo(condensationLevel.x2, condensationLevel.y);
    context.closePath();

    context.fillStyle = "#fff";
    context.fill();

    // Draw puffs

    var radius;

    for (i = 0; i < cloudPoints.length; ++i)
    {
        if (condensationLevel.y - cloudPoints[i].y < cloudPuffMaxRadius / 3.0) continue;

        radius = Math.random() * cloudPuffMaxRadius;
        context.beginPath();
        context.arc(cloudPoints[i].x1, cloudPoints[i].y, radius, 0, 2 * Math.PI, false);
        context.ellipse(cloudPoints[i].x1, cloudPoints[i].y, radius * 1.3, radius * 0.7, 0, 0, 2 * Math.PI);
        context.fill();

        radius = Math.random() * cloudPuffMaxRadius;
        context.beginPath();
        context.arc(cloudPoints[i].x2, cloudPoints[i].y, radius, 0, 2 * Math.PI, false);
        context.ellipse(cloudPoints[i].x2, cloudPoints[i].y, radius * 1.3, radius * 0.7, 0, 0, 2 * Math.PI);
        context.fill();
    }

    // Draw top puffs

    if (cloudPoints.length > 0)
    {
        var cloudTopLeftEdge = cloudPoints[cloudPoints.length - 1].x1;
        var cloudTopWidth = cloudPoints[cloudPoints.length - 1].x2 - cloudTopLeftEdge;
        var cloudTopY = getYOfAltitude(thermalData.thermalTop);

        for (var x = 0; x < cloudTopWidth; x += cloudPuffMaxRadius / 2.0)
        {
            radius = Math.random() * cloudPuffMaxRadius;
            context.beginPath();
            context.arc(cloudTopLeftEdge + x, cloudTopY, radius, 0, 2 * Math.PI, false);
            context.fill();
        }
    }

    // Draw vario

    if (showVario)
    {
        context.fillStyle = "#fff";
        context.strokeStyle = "#000";
        context.font = "bold 26px Arial";
        var lastPrinted = -varioInterval;

        for (i = 0; i < thermalData.strength.length; ++i)
        {
            var alt = thermalData.strength[i].altitude;
            if (alt > thermalData.cloudBase) break;
            if (alt - lastPrinted < varioInterval) continue;

            var impulse = thermalData.strength[i].impulse;

            context.fillText(roundToDecim(impulse, 2), canvas.width() / 2, getYOfAltitude(alt));
            context.strokeText(roundToDecim(impulse, 2), canvas.width() / 2, getYOfAltitude(alt));
            lastPrinted = alt;
        }
    }

}

function synchroTempSliderGauge(event, slider)
{
    $('#tempGauge' + $(event.target).data('altitude')).val(slider.value).trigger('change');
}

function synchroWindSliderGauge(event, slider)
{
    $('#windGauge' + $(event.target).data('altitude')).val(slider.value).trigger('change');
}


function synchroHumiSliderGauge(event, slider)
{
    $('#humiGauge' + $(event.target).data('altitude')).val(slider.value).trigger('change');
}

function reCreateGauges()
{
    var newWeatherStack = [];

    var leftGaugeHolder = $('#leftGaugeHolder');
    var rightGaugeHolder = $('#rightGaugeHolder');
    leftGaugeHolder.find('.gaugeBox').remove();
    rightGaugeHolder.find('.gaugeBox').remove();

    var measureLineCnt = maxShownAltitude / altimeterResolution;

    for (i = 0; i <= measureLineCnt; ++i)
    {
        altitude = Math.round(i * altimeterResolution);

        var temperature = roundToDecim(getTemperatureAt(altitude), 2);
        var wind = roundToDecim(getWindAt(altitude), 2);
        var humidity = roundToDecim(getAbsoluteHumidityAt(altitude), 2);

        leftGaugeHolder.append(''
            + '<div class="gaugeBox temperatureGaugeBox" id="tempGaugeBox' + altitude + '">'
            + '<input type="number" class="gauge temperatureGauge sliderGauge" id="tempGauge' + altitude + '" value="' + temperature + '">&#176;C'
            + '<div class="slider" id="tempSlider' + altitude + '"></div>'
            + '</div>'
        );

        leftGaugeHolder.append(''
            + '<div class="gaugeBox windGaugeBox" id="windGaugeBox' + altitude + '">'
            + '<input type="number" class="gauge windGauge sliderGauge" id="windGauge' + altitude + '" value="' + wind + '">m/s'
            + '<div class="slider" id="windSlider' + altitude + '"></div>'
            + '</div>'
        );

        rightGaugeHolder.append(''
            + '<div class="gaugeBox humiGaugeBox" id="humiGaugeBox' + altitude + '">'
            + '<input type="number" class="gauge humiGauge sliderGauge" id="humiGauge' + altitude + '" value="' + humidity + '">g/m<sup>3</sup>'
            + '<div class="slider" id="humiSlider' + altitude + '"></div>'
            + '</div>'
        );

        var tempGauge = $('#tempGauge' + altitude);
        var windGauge = $('#windGauge' + altitude);
        var humiGauge = $('#humiGauge' + altitude);
        var windSlider = $('#windSlider' + altitude);
        var tempSlider = $('#tempSlider' + altitude);
        var humiSlider = $('#humiSlider' + altitude);

        tempGauge.data('altitude', altitude);
        windGauge.data('altitude', altitude);
        humiGauge.data('altitude', altitude);
        windSlider.data('altitude', altitude);
        tempSlider.data('altitude', altitude);
        humiSlider.data('altitude', altitude);
        tempGauge.data('fieldName', 'temp');
        windGauge.data('fieldName', 'wind');
        humiGauge.data('fieldName', 'humidity');

        windSlider.width(parseInt(windGauge.innerWidth(), 10));
        windSlider.slider({
            range: "min",
            value: wind,
            min: -windSliderExtreme,
            max: windSliderExtreme,
            step: 0.5,
            slide: synchroWindSliderGauge
        });

        tempSlider.width(parseInt(tempGauge.outerWidth(), 10));
        tempSlider.slider({
            range: "min",
            value: temperature,
            min: -tempSliderExtreme - (altitude / 500),
            max: tempSliderExtreme + (altitude / 500),
            step: 1,
            slide: synchroTempSliderGauge
        });

        humiSlider.width(parseInt(humiGauge.outerWidth(), 10));
        humiSlider.slider({
            range: "min",
            value: humidity,
            min: 0,
            max: humiSliderExtreme,
            step: 0.01,
            slide: synchroHumiSliderGauge
        });

        newWeatherStack.push(new MeteoData(altitude, temperature, wind, humidity));
    }

    var gauges = $('.gauge');

    gauges.change(function(evt)
    {
        var target = $(evt.target);
        setDataAt(target.data('altitude'), target.data('fieldName'), parseFloat(target.val()));
        softRedraw();
    });
    gauges.mousedown(function()
    {
        softRedraw();
    });

    gauges.mouseup(stopSpinnerRedraw);
    gauges.focusout(stopSpinnerRedraw);
    gauges.mouseleave(stopSpinnerRedraw);

    var topmostLevel = newWeatherStack[newWeatherStack.length - 1];
    if (topmostLevel.alt < calculationsMaxHeight)
    {
        newWeatherStack.push(new AutoMeteoData(calculationsMaxHeight));
    }

    weatherStack = newWeatherStack;
}

function drawDiagram(dataSeries, dataGetter, pixelsPerUnit, zeroX, color)
{
    if (dataSeries.length < 2) return;

    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();

    for (var altitude = 0; altitude <= maxShownAltitude; altitude += calculationResolution)
    {
        var data = dataGetter(altitude);
        var pointX = zeroX + pixelsPerUnit * data;
        var pointY = getYOfAltitude(altitude);

        if (altitude === 0) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
    }

    context.stroke();
}

function drawDiagrams()
{
    var graphZeroX = canvasDOM.width * 10 / 13;
    const tempGraphPPU = (canvasDOM.width / 4) / /* maxT - minT */ 50;

    if (showTempGraph)
    {
        drawDiagram(weatherStack.map(function(e, i, a) { return {alt: e.alt, data: e.dewPt}; }), getDewPointAt, tempGraphPPU, graphZeroX, "#00f");
        drawDiagram(weatherStack.map(function(e, i, a) { return {alt: e.alt, data: e.temp}; }), getTemperatureAt, tempGraphPPU, graphZeroX, "#f00");

        // Scale

        context.strokeStyle = "#000";
        context.fillStyle = "#000";
        context.font = "14px Arial";

        for (var temp = -20; temp <= 30; temp += 10)
        {
            var x = graphZeroX + temp * tempGraphPPU;
            var groundLevelY = getYOfAltitude(0);

            context.beginPath();
            context.moveTo(x, groundLevelY);
            context.lineTo(x, groundLevelY - 10);
            context.stroke();

            context.fillText("" + temp + "°C", x + 4, groundLevelY - 4);
        }
    }
}

function redrawCanvas()
{
    //console.log("=== REDRAW =================================");
    canvasDOM = canvas.get()[0];

    var width = wrapperDiv.width();
    var height = wrapperDiv.height();

    canvasDOM.width = width;
    canvasDOM.height = height - 5;

    context.save();

    // debug
    var text = "" + width + " x " + height;
    context.fillText(text, 0, -height / 2);

    displayScale = height / referenceHeight;

    // altimeter

    var measureLineCnt = maxShownAltitude / altimeterResolution;
    var measureLineDist = (height - grassHeight) / measureLineCnt;

    // ===========================================================
    // ALTITUDE RELATED STUFF

    var i, altitude;

    // temperature coloring

    if (showTemperatureColoring)
    {
        tempGrad = context.createLinearGradient(0, 0, 0, height - grassHeight);

        for (i = 0; i <= measureLineCnt; ++i)
        {
            altitude = Math.round(i * altimeterResolution);
            var tempColor = getRgbForTemp(getTemperatureAt(altitude));
            tempGrad.addColorStop(1 - altitude / maxShownAltitude, 'rgba(' + tempColor.r + ', ' + tempColor.g + ', ' + tempColor.b + ', ' + temperatureColoringOpacity + ')');
        }

        context.fillStyle = tempGrad;
        context.fillRect(0, 0, showTemperatureColoringHalf ? width / 2 : width, height);
    }

    if (showHumidityColoring)
    {
        humiGrad = context.createLinearGradient(0, 0, 0, height - grassHeight);

        for (i = 0; i <= measureLineCnt; ++i)
        {
            altitude = Math.round(i * altimeterResolution);
            var color = getRgbForHumi($('#humiGauge' + altitude).val());
            humiGrad.addColorStop(1 - altitude / maxShownAltitude, 'rgba(' + color.r + ', ' + color.g + ', ' + color.b + ', ' + temperatureColoringOpacity + ')');
        }

        context.fillStyle = humiGrad;
        context.fillRect(showHumidityColoringHalf ? width / 2 : 0, 0, showHumidityColoringHalf ? width / 2 : width, height);
    }

    // thermals + clouds

    var thermalData = getThermalData();
    drawClouds(thermalData);

    // graphs

    drawDiagrams();

    // scale + gauges


    context.font = "16px Arial";
    context.fillStyle = showTemperatureColoring ? "#fff" : "#000";

    for (i = 0; i <= measureLineCnt; ++i)
    {
        var y = i * measureLineDist;
        altitude = maxShownAltitude - Math.round(i * altimeterResolution);

        if (showFullWidthLines)
        {
            context.strokeStyle = "#000";

            context.beginPath();
            context.lineWidth = 1;
            context.moveTo(0, y);
            context.lineTo(width, y);
            context.stroke();
        }

        context.strokeStyle = showTemperatureColoring ? "#fff" : "#000";
        context.lineWidth = 4;

        // left gauges
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(altimeterWidth, y);
        context.stroke();
        context.fillText("" + altitude + "m", 3, y + 20);

        // right gauges
        context.beginPath();
        context.moveTo(width, y);
        context.lineTo(width - altimeterWidth, y);
        context.stroke();
        context.fillText("" + altitude + "m", width - 53, y + 20);

        var gaugeY = ((maxShownAltitude - altitude) / altimeterResolution) * measureLineDist;
        $('#tempGaugeBox' + altitude).css('top', '' + (gaugeY + 5) + 'px');
        $('#windGaugeBox' + altitude).css('top', '' + (gaugeY + 31) + 'px');
        $('#humiGaugeBox' + altitude).css('top', '' + (gaugeY + 5) + 'px');

    }

    // Cloudbase line

    if (showCloudBase)
    {
        context.strokeStyle = "#600";
        context.font = "22px Arial";
        context.fillStyle = "#600";

        var y = getYOfAltitude(thermalData.cloudBase);

        context.lineWidth = 4;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
        context.fillText("" + Math.round(thermalData.cloudBase) + "m", 3, y + 22);
    }

    // grass

    context.fillStyle = "#090";
    context.fillRect(0, height - grassHeight, width, grassHeight);
}

// =====================================================================================================================
// =====================================================================================================================
// Main loop

$(function()
{
    canvas = $('#thermalCanvas');
    wrapperDiv = canvas;
    context = canvas.get()[0].getContext("2d");

    $(window).resize(softRedraw);

    $('#numMaxAltitude').val(maxShownAltitude);
    $('#numAltitudeResolution').val(altimeterResolution);
    $('#cbTempColoring').prop('checked', showTemperatureColoring);
    $('#cbTempColoringHalf').prop('checked', showTemperatureColoringHalf);
    $('#numTempColoringOpacity').val(temperatureColoringOpacity);
    $('#cbFullWidthAltLines').prop('checked', showFullWidthLines);
    $('#cbShowCloudbase').prop('checked', showCloudBase);
    $('#cbHumiColoring').prop('checked', showHumidityColoring);
    $('#cbHumiColoringHalf').prop('checked', showHumidityColoringHalf);
    $('#numHumiColoringOpacity').val(humidityColoringOpacity);
    $('#numAbsoluteHumi').val(defaultGroundAbsoluteHumidity);
    $('#numGroundPressure').val(groundPressure);
    $('#cbThermalVario').prop('checked', showVario);
    $('#numSolarStrength').val(solarStrength);
    $('#cbLockSolarTemps').prop('checked', lockSolarToTemps);
    $('#numVarioResolution').val(varioInterval);
    $('#cbTempGraph').prop('checked', showTempGraph);

    $('.guiControl').change(function()
    {
        maxShownAltitude = parseFloat($('#numMaxAltitude').val());
        altimeterResolution = parseFloat($('#numAltitudeResolution').val());
        showTemperatureColoring = $('#cbTempColoring').is(':checked');
        showTemperatureColoringHalf = $('#cbTempColoringHalf').is(':checked');
        temperatureColoringOpacity = parseFloat($('#numTempColoringOpacity').val());
        showFullWidthLines = $('#cbFullWidthAltLines').is(':checked');
        showCloudBase = $('#cbShowCloudbase').is(':checked');
        showHumidityColoring = $('#cbHumiColoring').is(':checked');
        showHumidityColoringHalf = $('#cbHumiColoringHalf').is(':checked');
        humidityColoringOpacity = parseFloat($('#numHumiColoringOpacity').val());
        defaultGroundAbsoluteHumidity = parseFloat($('#numAbsoluteHumi').val());
        groundPressure = parseFloat($('#numGroundPressure').val());
        showVario = $('#cbThermalVario').is(':checked');
        solarStrength = parseFloat($('#numSolarStrength').val());
        lockSolarToTemps = $('#cbLockSolarTemps').is(':checked');
        varioInterval = parseFloat($('#numVarioResolution').val());
        showTempGraph = $('#cbTempGraph').is(':checked');

        softRedraw();
    });

    // Default weather

    weatherStack.push(new MeteoData(0, defaultGroundTemperature, 0.0, defaultGroundAbsoluteHumidity));
    weatherStack.push(new MeteoData(9500, defaultGroundTemperature - (9500 / 100.0) * defaultTemperatureGradient, 0.0, 1.0));
    weatherStack.push(new MeteoData(calculationsMaxHeight, -20.0, 0.0, 0.5));

    $('.altiControl').change(function()
    {
        reCreateGauges();
        softRedraw();
    });

    reCreateGauges();
    redrawCanvas();
});
