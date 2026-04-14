import './style.css';
import { PanoViewer } from './PanoViewer.js';

// const PANO_BASE_PATH = '/panodata/Office2-2-rooms';
const PANO_BASE_PATH = '/panodata/Office1-21-rooms';

async function init() {
  const csvText = await fetch(`${PANO_BASE_PATH}/Office.csv`).then((r) => r.text());
  const panoData = parseCsv(csvText);

  const container = document.getElementById('app');
  const viewer = new PanoViewer(container, { basePath: PANO_BASE_PATH });
  await viewer.loadPanos(panoData);
}

function parseCsv(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());

  const rows = lines.slice(1).map((line) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i]?.trim();
    });
    return row;
  });

  // Grid bounds for coordinate conversion (same as engage-web panoMapping.ts)
  const coords = rows.map((r) => ({
    x: parseFloat(r.x),
    y: parseFloat(r.y),
    z: parseFloat(r.z || '0'),
  }));

  const minX = Math.min(...coords.map((c) => c.x));
  const maxX = Math.max(...coords.map((c) => c.x));
  const minY = Math.min(...coords.map((c) => c.y));
  const maxY = Math.max(...coords.map((c) => c.y));
  const minZ = Math.min(...coords.map((c) => c.z));
  const maxZ = Math.max(...coords.map((c) => c.z));

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;

  return rows.map((row, i) => ({
    filename: row.filename,
    position: {
      x: coords[i].x - centerX,
      y: coords[i].z - centerZ, // elevation -> Y
      z: centerY - coords[i].y, // northing inverted -> Z
    },
    quaternion:
      row.qx !== undefined
        ? {
            x: parseFloat(row.qx),
            y: parseFloat(row.qy),
            z: parseFloat(row.qz),
            w: parseFloat(row.qw),
          }
        : null,
  }));
}

init();
