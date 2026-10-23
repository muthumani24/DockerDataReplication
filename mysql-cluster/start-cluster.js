// Run by start.ps1 inside the mysql-1 container (MySQL Shell, JavaScript mode).
// Brings DevOpsCluster online after any kind of start:
//   - cluster already running      -> nothing to do
//   - complete outage (all stopped) -> dba.rebootClusterFromCompleteOutage()
// then makes mysql-1 the PRIMARY again.

var CLUSTER = "DevOpsCluster";
var NODES = ["mysql-1:3306", "mysql-2:3306", "mysql-3:3306"];
var PREFERRED_PRIMARY = "mysql-1:3306";

function waitForNodes() {
    for (var i = 0; i < 60; i++) {
        var up = 0;
        NODES.forEach(function (n) {
            try {
                var s = mysql.getClassicSession("root@" + n, os.getenv("MYSQL_ROOT_PASSWORD"));
                s.close();
                up++;
            } catch (e) { }
        });
        if (up === NODES.length) { print("All 3 MySQL nodes are accepting connections.\n"); return; }
        print("Waiting for MySQL nodes (" + up + "/3 up)...\n");
        os.sleep(5);
    }
    throw new Error("Not all MySQL nodes came up within 5 minutes");
}

function getOrRebootCluster() {
    try {
        var c = dba.getCluster(CLUSTER);
        print("Cluster is already running.\n");
        return c;
    } catch (e) {
        print("Cluster is offline (complete outage). Rebooting it...\n");
    }
    // Nodes may still be finishing their own failed join attempts; retry a few times
    for (var i = 1; i <= 6; i++) {
        try {
            // Shell picks the node with the most transactions as the starting point
            return dba.rebootClusterFromCompleteOutage(CLUSTER);
        } catch (e) {
            print("Reboot attempt " + i + " failed: " + e.message + "\n");
            os.sleep(10);
        }
    }
    throw new Error("Could not reboot the cluster; check the container logs");
}

waitForNodes();
var cluster = getOrRebootCluster();

var status = cluster.status().defaultReplicaSet;
if (status.primary !== PREFERRED_PRIMARY &&
    status.topology[PREFERRED_PRIMARY] &&
    status.topology[PREFERRED_PRIMARY].status === "ONLINE") {
    print("Switching PRIMARY back to " + PREFERRED_PRIMARY + "...\n");
    cluster.setPrimaryInstance(PREFERRED_PRIMARY);
    status = cluster.status().defaultReplicaSet;
}

print("\n" + status.status + " | " + status.statusText + "\n");
for (var k in status.topology) {
    var t = status.topology[k];
    print("  " + k + "  " + t.memberRole + "  " + t.mode + "  " + t.status + "\n");
}
