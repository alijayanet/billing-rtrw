const snmp = require('net-snmp');
const host = '192.168.8.88';
const community = 'SNMPREAD';

const session = snmp.createSession(host, community, {
  port: 161,
  timeout: 5000,
  retries: 1,
  version: snmp.Version2c
});

async function run() {
  console.log("Scanning Ports for Traffic...");
  session.walk('1.3.6.1.2.1.31.1.1.1.6', 50, (vbs) => {
    vbs.forEach(v => {
      if (v.value > 0) {
        console.log(`Port Index ${v.oid.split('.').pop()}: ${v.value} bytes In`);
      }
    });
  }, () => {
    session.walk('1.3.6.1.2.1.2.2.1.2', 50, (vbs) => {
      vbs.forEach(v => {
        console.log(`Index ${v.oid.split('.').pop()} Name: ${v.value}`);
      });
    }, () => {
       session.close();
    });
  });
}

run();
setTimeout(() => process.exit(0), 20000);
