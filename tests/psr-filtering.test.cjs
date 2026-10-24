const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function harness() {
  const elements = {};
  for (const [id, value] of Object.entries({ networkSelect:'ALL', metricSelect:'outage_count', hotspotLimit:'ALL', outageTypeSelect:'ALL', startDate:'2026-09-01', endDate:'2026-09-24', minOutages:'0', minCustomers:'0', minHours:'0', cseNeedSelect:'child_under_5', cseReachThreshold:'', cseCouncilSearch:'ALL', cseToggle:'', cseFilterPowercuts:'' })) {
    elements[id] = { value, checked: false, listeners:{}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } };
  }
  const callbacks = [];
  const ctx = vm.createContext({ console, document:{ getElementById:id=>elements[id] || null, addEventListener:(type,fn)=>callbacks.push(fn) }, setTimeout:fn=>fn() });
  ctx.window = ctx;
  for (const name of ['app','dashboard-duration-clipping','campaign-exports','cse-layer','cse-sector-filter','cse-postcode-download']) vm.runInContext(fs.readFileSync(path.join(root,`docs/${name}.js`),'utf8'),ctx);
  const run = source => vm.runInContext(source,ctx);
  const json = source => JSON.parse(run(`JSON.stringify(${source})`));
  run(`state.payload = { available_start:'2026-09-01', available_end:'2026-09-24', events:[] }`);
  return { ctx, elements, run, json, callbacks };
}
function fixture(h) {
  h.run(`
    var makeEvent = (sector, id, codes, overrides={}) => ({ postcode_sector:sector, network:'N', outage_id:id, outage_type:'HV', first_seen:'2026-09-10T00:00:00Z', last_seen:'2026-09-10T02:00:00Z', total_customers_affected:10, postcodes_detail:codes.map((code,i)=>({postcode:sector+'A'+i,local_authority_code:code})), ...overrides });
    state.payload.events = [makeEvent('AA1 1','1',['A','B','']),makeEvent('AA1 1','2',['A','B','']),makeEvent('BB1 1','3',['B']),makeEvent('CC1 1','4',['A'],{network:'OTHER'}),makeEvent('DD1 1','5',['A'],{first_seen:'2026-08-01',last_seen:'2026-08-02'})];
    state.payload.events.forEach(e=>state.boundaryBySector.set(e.postcode_sector,{}));
    cseState.rowsByCode = new Map([['A',{local_authority_code:'A',needs:{child_under_5:{psr_reach:0.8}}}],['B',{local_authority_code:'B',needs:{child_under_5:{psr_reach:0.9}}}]]);
  `);
  h.elements.networkSelect.value='N';
}
test('shared activation: overlay alone, absent control, and disabled overlay preserve outage population',()=>{
 const h=harness(); fixture(h); const baseline=h.json('getDoorDropRows()');
 h.elements.cseToggle.checked=true; h.elements.cseReachThreshold.value='80';
 assert.deepEqual(h.json('getDoorDropRows()'),baseline);
 delete h.elements.cseFilterPowercuts;
 assert.deepEqual(h.json('getDoorDropRows()'),baseline);
 assert.equal(h.run('cseCampaignFilterEnabled()'),false);
});
test('maximum reach intersects postcodes, includes exactly 80%, and zero matches stays empty',()=>{
 const h=harness(); fixture(h); const base=new Set(h.json('getDoorDropRows().map(r=>r.postcode)'));
 h.elements.cseToggle.checked=h.elements.cseFilterPowercuts.checked=true;
 let previous=base;
 for(const threshold of ['',100,90,80,79,0]) {
   h.elements.cseReachThreshold.value=String(threshold);
   const postcodes=h.json('getDoorDropRows().map(r=>r.postcode)');
   assert.ok(postcodes.every(p=>previous.has(p))); previous=new Set(postcodes);
   assert.deepEqual(h.json('getFilteredSectors().flatMap(r=>r.full_postcodes).sort()'),postcodes.slice().sort());
   if(threshold===80) assert.equal(postcodes.length,1);
   if(threshold===79) { assert.equal(postcodes.length,0); assert.deepEqual(h.json('getMetaSectors()'),[]); }
 }
 h.elements.cseToggle.checked=false;
 assert.equal(h.json('getDoorDropRows()').length,base.size);
});
test('Top N and outage thresholds are applied before PSR, with no backfill',()=>{
 const h=harness(); fixture(h); h.elements.hotspotLimit.value='1';
 h.elements.cseToggle.checked=h.elements.cseFilterPowercuts.checked=true;
 h.elements.cseCouncilSearch.value='B';
 assert.equal(h.json('getDoorDropRows()').length,1);
 assert.equal(h.json('cseAuthorityPowercutPostcodes("B")').length,1);
 h.elements.minOutages.value='3';
 assert.deepEqual(h.json('getDoorDropRows()'),[]);
 assert.deepEqual(h.json('cseAuthorityPowercutPostcodes("B")'),[]);
});
test('missing mappings and unloaded/empty CSE data do not bypass active filter',()=>{
 const h=harness(); fixture(h); h.elements.cseToggle.checked=h.elements.cseFilterPowercuts.checked=true;
 h.run('cseState.rowsByCode.clear()'); assert.deepEqual(h.json('getFilteredSectors()'),[]);
 fixture(h); h.run('state.payload.events.forEach(e=>e.postcodes_detail.forEach(d=>d.local_authority_code=""))');
 assert.deepEqual(h.json('getFilteredSectors()'),[]);
});
test('combined CSV only contains postcodes belonging to its matching council',()=>{
 const h=harness(); fixture(h); h.elements.cseCouncilSearch.value='A';
 const csv=h.run('buildCseCampaignCsv()');
 assert.ok(csv.includes('AA1 1A0')); assert.ok(!csv.includes('AA1 1A1')); assert.ok(!csv.includes('BB1'));
});
test('real dashboard: every need and successively stricter thresholds remain subsets',()=>{
 const h=harness();
 const data=JSON.parse(fs.readFileSync(path.join(root,'docs/data/dashboard_rolling_12m.json')));
 const cse=JSON.parse(fs.readFileSync(path.join(root,'docs/data/cse-local-authority-psr.json')));
 h.ctx.payload=data; h.ctx.cseRows=cse.rows;
 h.run('state.payload=payload; payload.events.forEach(e=>state.boundaryBySector.set(e.postcode_sector,{})); cseState.rowsByCode=new Map(cseRows.map(r=>[r.local_authority_code,r]))');
 h.elements.startDate.value=data.available_start; h.elements.endDate.value=data.available_end;
 h.elements.hotspotLimit.value='100';
 const baseline=new Set(h.json('getDoorDropRows().map(r=>r.postcode)'));
 h.elements.cseToggle.checked=h.elements.cseFilterPowercuts.checked=true;
 const counts={};
 for(const need of Object.keys(cse.rows[0].needs)) {
  h.elements.cseNeedSelect.value=need; let previous=baseline; counts[need]=[];
  for(const threshold of ['',100,80,50,20,0]) {
   h.elements.cseReachThreshold.value=String(threshold);
   const codes=h.json('getDoorDropRows().map(r=>r.postcode)');
   assert.ok(codes.every(p=>previous.has(p)),`${need}/${threshold} expanded`);
   previous=new Set(codes); counts[need].push(codes.length);
  }
 }
 console.log('Real data baseline:',baseline.size,'child_under_5 counts (blank,100,80,50,20,0):',counts.child_under_5);
});

test('filter-control changes refresh synchronously and slow loading refreshes after completion', async()=>{
 const h=harness(); fixture(h);
 h.run('window.updateAll = () => { window.refreshes = (window.refreshes || 0) + 1; }; window.refreshes=0;');
 // Register only the sector-filter DOMContentLoaded handler.
 h.callbacks[3]();
 h.elements.cseFilterPowercuts.listeners.change[0]();
 assert.equal(h.ctx.refreshes,1);
 h.run('showCseControls = () => {}; ensureCseDataLoaded = () => new Promise(resolve => { window.finishLoading=resolve; }); setupCseControls();');
 h.elements.cseToggle.checked=true;
 const listeners=h.elements.cseToggle.listeners.change;
 const pending=listeners[listeners.length-1]({currentTarget:h.elements.cseToggle});
 assert.equal(h.ctx.refreshes,1);
 h.ctx.finishLoading(); await pending;
 assert.equal(h.ctx.refreshes,2);
});
