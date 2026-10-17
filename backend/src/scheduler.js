// Runs automations at set times of day. Each run lands at a random moment inside
// a window (e.g. 09:00 + up to 40 min) and each phone gets its own extra offset,
// so the phones never act in lockstep or at the exact same time every day.
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, readJson, writeJson } = require('./paths');
const account = require('./account');

const FILE = path.join(DATA_DIR, 'schedules.json');
const TICK_MS = 30000;
const LATE_LIMIT_MS = 30 * 60000; // skip a slot that was missed by more than this (app was closed)

// Same inputs always give the same 0-1 number, so a slot's random time is stable across ticks and restarts.
const seeded = (...parts) => crypto.createHash('md5').update(parts.join('|')).digest().readUInt32BE(0) / 0xffffffff;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

class Scheduler {
    constructor(devices, runner) {
        this.devices = devices;
        this.runner = runner;
        this.schedules = readJson(FILE, []);
        this.log = []; // what the scheduler did, newest last
    }

    start() {
        this.timer = setInterval(() => this.tick(), TICK_MS);
        setTimeout(() => this.tick(), 5000);
    }

    stop() {
        clearInterval(this.timer);
    }

    list() {
        return this.schedules.map((s) => ({ ...s, next: this.nextRun(s) }));
    }

    save(input) {
        const s = {
            id: input.id || crypto.randomUUID().slice(0, 8),
            name: String(input.name || input.automationId || 'Schedule'),
            automationId: String(input.automationId || ''),
            phones: Array.isArray(input.phones) && input.phones.length ? input.phones : 'all',
            params: input.params || {},
            times: (input.times || []).map(String).filter((t) => /^\d{1,2}:\d{2}$/.test(t)),
            windowMinutes: Math.max(0, Number(input.windowMinutes ?? 30)),
            days: Array.isArray(input.days) && input.days.length ? input.days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
            enabled: input.enabled !== false,
            ran: this.schedules.find((x) => x.id === input.id)?.ran || {},
        };
        if (!s.automationId) throw new Error('Pick an automation');
        if (!s.times.length) throw new Error('Add at least one time, like 09:00');
        if (!this.runner.loadAll().some((a) => a.id === s.automationId))
            throw new Error(`No automation called "${s.automationId}"`);
        const i = this.schedules.findIndex((x) => x.id === s.id);
        if (i >= 0) this.schedules[i] = s;
        else this.schedules.push(s);
        this.persist();
        return s;
    }

    remove(id) {
        this.schedules = this.schedules.filter((s) => s.id !== id);
        this.persist();
    }

    persist() {
        writeJson(FILE, this.schedules);
    }

    slotTime(s, date, time, udid = '') {
        const [h, m] = time.split(':').map(Number);
        const t = new Date(date);
        t.setHours(h, m, 0, 0);
        const offset = seeded(s.id, dayKey(date), time, udid) * s.windowMinutes * 60000;
        return t.getTime() + offset;
    }

    nextRun(s) {
        if (!s.enabled) return null;
        const now = Date.now();
        for (let d = 0; d < 8; d++) {
            const date = new Date();
            date.setDate(date.getDate() + d);
            if (!s.days.includes(date.getDay())) continue;
            const times = s.times
                .map((t) => this.slotTime(s, date, t))
                .filter((t) => t > now)
                .sort();
            if (times.length) return times[0];
        }
        return null;
    }

    phonesFor(s) {
        const ready = this.devices.readyDevices();
        if (s.phones === 'all') return ready;
        return ready.filter((d) => s.phones.includes(d.udid) || s.phones.includes(d.name));
    }

    record(text) {
        this.log.push({ at: Date.now(), text });
        if (this.log.length > 200) this.log.shift();
    }

    tick() {
        if (!account.allowed()) return; // nothing runs while Market is waiting for an AffRev sign-in
        const now = Date.now();
        const today = new Date();
        let changed = false;
        for (const s of this.schedules) {
            if (!s.enabled || !s.days.includes(today.getDay())) continue;
            for (const time of s.times) {
                for (const device of this.phonesFor(s)) {
                    const key = `${dayKey(today)} ${time} ${device.udid}`;
                    if (s.ran[key]) continue;
                    const at = this.slotTime(s, today, time, device.udid);
                    if (now < at) continue;
                    s.ran[key] = now;
                    changed = true;
                    if (now - at > LATE_LIMIT_MS) continue;
                    const busy = this.runner.runningOn(device.udid);
                    if (busy) {
                        this.record(`${s.name}: skipped ${device.name}, it was busy with "${busy.automationName}"`);
                        continue;
                    }
                    try {
                        this.runner.start(s.automationId, [device.udid], s.params, 'schedule');
                        this.record(`${s.name}: started on ${device.name}`);
                    } catch (e) {
                        this.record(`${s.name}: could not start on ${device.name}: ${e.message}`);
                    }
                }
            }
            // Forget run markers older than two days.
            for (const key of Object.keys(s.ran)) if (now - s.ran[key] > 2 * 86400000) delete s.ran[key];
        }
        if (changed) this.persist();
    }
}

module.exports = { Scheduler };
