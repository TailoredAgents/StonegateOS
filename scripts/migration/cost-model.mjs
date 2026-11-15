// Estimate only. Feed privately captured Render hourly means. Replacement
// scenarios use the November 15 authenticated PlanetScale configuration quote.
import {readFile} from 'node:fs/promises';
const filename=process.argv[2];
if(!filename)throw Error('Private resource-cost-inputs.json path required');
const input=JSON.parse(await readFile(filename,'utf8'));
const seconds=30*24*60*60;
const cpu=Object.values(input.summary).reduce((sum,s)=>sum+s.cpu_usage.mean,0);
if(!Number.isFinite(cpu)||cpu<0)throw Error('Invalid CPU metrics');
const round=n=>Math.round(n*100)/100;
function estimate({memoryGiB,diskGB,cpuMultiplier,availableAllowances,relayMonthly,objectActiveFraction=1,databaseMonthly=23.50}) {
  const memory=Math.max(0,memoryGiB*seconds-(availableAllowances?25*3600:0))*0.0000025;
  const disk=Math.max(0,diskGB*seconds-(availableAllowances?200*3600:0))*0.00000007;
  const compute=Math.max(0,cpu*cpuMultiplier*seconds-(availableAllowances?375*60:0))*0.000020;
  // Four continuously monitored DOs, 128 MB each. Current pricing rounds
  // excess duration UP to million GB-second billing units.
  const doGBSeconds=4*0.128*seconds*objectActiveFraction;
  const durableObjects=Math.ceil(Math.max(0,doGBSeconds-(availableAllowances?400000:0))/1e6)*12.50;
  const costs={containerMemory:round(memory),containerDisk:round(disk),containerCpu:round(compute),durableObjects,
    workersPlanAllocation:5,database:databaseMonthly,relay:relayMonthly};
  const monthly=round(Object.values(costs).reduce((a,b)=>a+b,0));
  return {assumptions:{memoryGiB,diskGB,cpuMultiplier,availableAllowances,relayMonthly,objectActiveFraction,databaseMonthly},costs,monthly,
    savingsAgainstRender105_50:round(105.50-monthly)};
}
console.log(JSON.stringify({asOf:input.at,metricRangeDays:input.rangeDays,observedAverageCpuCores:cpu,
  caveats:['Hourly means do not measure memory peaks or latency under load.',
    'Container CPU transfer is an estimate; multipliers allow for overhead.',
    'Shared account allowances may already be consumed by other applications.',
    'Assumes four continuously running Containers; Durable Object active fraction is scenario-specific and not yet measured in production.',
    'Replacement quote: PlanetScale PG17.12 PS-10 ARM single node, 1GB RAM, 15GB storage, Virginia, $11/month; not provisioned or load-tested.',
    'Excludes unmeasured request, logs, egress and object-storage overages, taxes, and temporary restore overlap.'],
  scenarios:{
    servicesMovedWithRelay:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:2,availableAllowances:true,relayMonthly:7}),
    servicesMovedAllowancesConsumed:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:5,availableAllowances:false,relayMonthly:7}),
    relayRemovedSameDatabasePrice:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:2,availableAllowances:true,relayMonthly:0}),
    idleControllersWithRelay:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:2,availableAllowances:true,relayMonthly:7,objectActiveFraction:0.05}),
    idleControllersNoRelaySameDatabasePrice:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:2,availableAllowances:true,relayMonthly:0,objectActiveFraction:0.05}),
    quotedReplacementContinuousControllers:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:2,availableAllowances:true,relayMonthly:0,databaseMonthly:11}),
    quotedReplacementIdleControllers:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:2,availableAllowances:true,relayMonthly:0,databaseMonthly:11,objectActiveFraction:0.05}),
    quotedReplacementAllowancesConsumed:estimate({memoryGiB:6,diskGB:16,cpuMultiplier:5,availableAllowances:false,relayMonthly:0,databaseMonthly:11})
  },sources:['https://developers.cloudflare.com/containers/platform/pricing/',
    'https://developers.cloudflare.com/durable-objects/platform/pricing/',
    'https://planetscale.com/pricing']},null,2));
