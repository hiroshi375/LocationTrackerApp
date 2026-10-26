const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Run after npm run verify:backend:synth. Check the deployable graph, not source strings.
const folder = path.join(__dirname, '../.amplify/artifacts/group-access-verify');
const templates = fs.readdirSync(folder).filter(name => name.endsWith('.template.json'))
    .map(name => ({ name, template: JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) }));
const fields = ['createLocationLog', 'createRecordingSession', 'deleteLocationLog', 'deleteRecordingSession'];
for (const field of fields) {
    test(`${field} compatibility waits for its Lambda data source`, () => {
        const candidates = templates.flatMap(({ template }) => Object.entries(template.Resources ?? {})
            .filter(([, resource]) => resource.Type === 'AWS::AppSync::FunctionConfiguration' && resource.Properties.Name === `${field}OwnerCompatibility`)
            .map(([id, resource]) => ({ id, resource, template })));
        assert.equal(candidates.length, 1);
        const { resource, template } = candidates[0];
        const sources = Object.entries(template.Resources).filter(([, item]) => item.Type === 'AWS::AppSync::DataSource'
            && item.Properties.Name === resource.Properties.DataSourceName);
        assert.equal(sources.length, 1, 'function and data source must be in the same nested stack');
        assert.ok(resource.DependsOn.includes(sources[0][0]), 'name alone does not order CloudFormation resources');
        assert.equal(sources[0][1].Properties.Type, 'AWS_LAMBDA');
        const resolvers = templates.flatMap(({ template }) => Object.values(template.Resources ?? {}))
            .filter(item => item.Type === 'AWS::AppSync::Resolver' && item.Properties.TypeName === 'Mutation'
                && item.Properties.FieldName === field);
        assert.equal(resolvers.length, 1);
        assert.equal(resolvers[0].Properties.PipelineConfig.Functions.length, 1);
    });
}

test('generated CloudFormation resource graphs contain no circular deployment dependencies', () => {
    for (const { name, template } of templates) {
        const resources = template.Resources ?? {};
        const edges = new Map();
        function references(value, found = new Set()) {
            if (!value || typeof value !== 'object') return found;
            if (typeof value.Ref === 'string' && resources[value.Ref]) found.add(value.Ref);
            const target = value['Fn::GetAtt'];
            if (Array.isArray(target) && resources[target[0]]) found.add(target[0]);
            for (const child of Object.values(value)) references(child, found);
            return found;
        }
        for (const [id, resource] of Object.entries(resources)) {
            const dependencies = references(resource.Properties);
            for (const target of [resource.DependsOn ?? []].flat()) if (resources[target]) dependencies.add(target);
            edges.set(id, [...dependencies]);
        }
        const done = new Set();
        const visiting = new Set();
        function visit(id, trail = []) {
            if (visiting.has(id)) assert.fail(`${name}: ${[...trail, id].join(' -> ')}`);
            if (done.has(id)) return;
            visiting.add(id);
            for (const target of edges.get(id)) visit(target, [...trail, id]);
            visiting.delete(id); done.add(id);
        }
        for (const id of edges.keys()) visit(id);
    }
});

for (const [model, variable] of [['LocationLog', 'HISTORICAL_LOCATION_LOG_TABLE_NAME'], ['RecordingSession', 'HISTORICAL_RECORDING_SESSION_TABLE_NAME']]) {
    test(`${model} Lambda target is the existing model table, without a resolver-stack cycle`, () => {
        const parent = templates.find(({ template }) => Object.entries(template.Resources ?? {}).some(([id, value]) =>
            id.startsWith('sharegroupapilambda') && value.Type === 'AWS::Lambda::Function')).template;
        const fn = Object.entries(parent.Resources).find(([id, value]) => id.startsWith('sharegroupapilambda') && value.Type === 'AWS::Lambda::Function')[1];
        const target = fn.Properties.Environment.Variables[variable]['Fn::Join'][1];
        const nested = templates.flatMap(({ template }) => Object.values(template.Resources ?? {}))
            .find(value => value.Type === 'Custom::AmplifyDynamoDBTable' && value.Properties.tableName?.['Fn::Join']?.[1]?.[0] === `${model}-`);
        assert.ok(nested);
        const definition = nested.Properties.tableName['Fn::Join'][1];
        assert.equal(target[0], definition[0]);
        assert.equal(target[2], definition[2]);
        const stack = Object.entries(parent.Resources).find(([id, value]) => id.startsWith(`amplifyData${model}NestedStack`) && value.Type === 'AWS::CloudFormation::Stack')[1];
        assert.deepEqual(target[1], stack.Properties.Parameters[definition[1].Ref]);
        assert.equal(parent.Resources[target[1]['Fn::GetAtt'][0]].Type, 'AWS::AppSync::GraphQLApi');
    });
}
