import * as fs from 'fs';
import * as path from 'path';
import { AGENT_INSTRUCTION } from '../src/remoteHosts/agentInstruction';

describe('AGENT_INSTRUCTION', () => {
	it('Should be the block in docs/remote-hosts-for-agents.md', () => {
		// Setup
		const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'remote-hosts-for-agents.md'), 'utf8').replace(/\r\n/g, '\n');
		const match = doc.match(/\n````markdown\n([\s\S]*?)\n````\n/);

		// Assert
		expect(match).not.toBeNull();
		expect(match![1]).toBe(AGENT_INSTRUCTION);
	});
});
