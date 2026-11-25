// Windows fleet children in resident-node, part 3 of 3. See fleet-node-children-1.test.mjs for the split.
import { fleetChildFiles, runFleetChildren } from './fleet-node-children.test.mjs';

runFleetChildren(fleetChildFiles(), 2);
