import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('compile-pug-templates script', () => {
  const scriptPath = path.join(__dirname, '../compile-pug-templates.ts');
  const testTempDir = path.join(__dirname, '__temp__');

  beforeEach(() => {
    // Create temp directory for tests
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testTempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
  });

  it('should compile pug templates from a directory', () => {
    const templatesDir = path.join(testTempDir, 'templates');
    const outputFile = path.join(testTempDir, 'output.json');

    // Create test templates directory
    fs.mkdirSync(templatesDir, { recursive: true });

    // Create test pug files
    fs.writeFileSync(path.join(templatesDir, 'email.pug'), 'p Hello #{name}');
    fs.writeFileSync(path.join(templatesDir, 'subject.pug'), '| Welcome #{user}');

    // Run the script
    execSync(`npx ts-node ${scriptPath} ${templatesDir} ${outputFile}`, {
      stdio: 'pipe',
    });

    // Verify output file exists
    expect(fs.existsSync(outputFile)).toBe(true);

    // Verify content
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(result['email.pug']).toBe('p Hello #{name}');
    expect(result['subject.pug']).toBe('| Welcome #{user}');
  });

  it('should handle nested directories', () => {
    const templatesDir = path.join(testTempDir, 'templates');
    const outputFile = path.join(testTempDir, 'output.json');

    // Create nested directory structure
    fs.mkdirSync(path.join(templatesDir, 'emails', 'notifications'), { recursive: true });

    // Create test pug files in nested directories
    fs.writeFileSync(path.join(templatesDir, 'root.pug'), 'p Root template');
    fs.writeFileSync(path.join(templatesDir, 'emails', 'welcome.pug'), 'p Welcome email');
    fs.writeFileSync(
      path.join(templatesDir, 'emails', 'notifications', 'alert.pug'),
      'p Alert notification'
    );

    // Run the script
    execSync(`npx ts-node ${scriptPath} ${templatesDir} ${outputFile}`, {
      stdio: 'pipe',
    });

    // Verify content
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(result['root.pug']).toBe('p Root template');
    expect(result[path.join('emails', 'welcome.pug')]).toBe('p Welcome email');
    expect(result[path.join('emails', 'notifications', 'alert.pug')]).toBe('p Alert notification');
  });

  it('should only include .pug files', () => {
    const templatesDir = path.join(testTempDir, 'templates');
    const outputFile = path.join(testTempDir, 'output.json');

    fs.mkdirSync(templatesDir, { recursive: true });

    // Create various file types
    fs.writeFileSync(path.join(templatesDir, 'template.pug'), 'p Pug template');
    fs.writeFileSync(path.join(templatesDir, 'styles.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(templatesDir, 'script.js'), 'console.log("test");');
    fs.writeFileSync(path.join(templatesDir, 'readme.md'), '# README');

    // Run the script
    execSync(`npx ts-node ${scriptPath} ${templatesDir} ${outputFile}`, {
      stdio: 'pipe',
    });

    // Verify only .pug files are included
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(Object.keys(result)).toEqual(['template.pug']);
    expect(result['template.pug']).toBe('p Pug template');
  });

  it('should handle empty directories', () => {
    const templatesDir = path.join(testTempDir, 'empty-templates');
    const outputFile = path.join(testTempDir, 'output.json');

    fs.mkdirSync(templatesDir, { recursive: true });

    // Run the script
    execSync(`npx ts-node ${scriptPath} ${templatesDir} ${outputFile}`, {
      stdio: 'pipe',
    });

    // Verify output file exists and is empty object
    expect(fs.existsSync(outputFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(result).toEqual({});
  });

  it('should error when input directory does not exist', () => {
    const nonExistentDir = path.join(testTempDir, 'non-existent');
    const outputFile = path.join(testTempDir, 'output.json');

    // Verify the script exits with error
    expect(() => {
      execSync(`npx ts-node ${scriptPath} ${nonExistentDir} ${outputFile}`, {
        stdio: 'pipe',
      });
    }).toThrow();

    // Verify output file was not created
    expect(fs.existsSync(outputFile)).toBe(false);
  });

  it('should error when input is not a directory', () => {
    const notADir = path.join(testTempDir, 'file.txt');
    const outputFile = path.join(testTempDir, 'output.json');

    // Create a file instead of directory
    fs.writeFileSync(notADir, 'content');

    // Verify the script exits with error
    expect(() => {
      execSync(`npx ts-node ${scriptPath} ${notADir} ${outputFile}`, {
        stdio: 'pipe',
      });
    }).toThrow();
  });

  it('should preserve template content exactly as written', () => {
    const templatesDir = path.join(testTempDir, 'templates');
    const outputFile = path.join(testTempDir, 'output.json');

    fs.mkdirSync(templatesDir, { recursive: true });

    // Create template with specific formatting and whitespace
    const templateContent = `html
  head
    title Email Template
  body
    h1 Hello #{name}!
    p.
      This is a multi-line
      paragraph with preserved
      whitespace.`;

    fs.writeFileSync(path.join(templatesDir, 'complex.pug'), templateContent);

    // Run the script
    execSync(`npx ts-node ${scriptPath} ${templatesDir} ${outputFile}`, {
      stdio: 'pipe',
    });

    // Verify content is preserved exactly
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(result['complex.pug']).toBe(templateContent);
  });

  it('should handle special characters in file names', () => {
    const templatesDir = path.join(testTempDir, 'templates');
    const outputFile = path.join(testTempDir, 'output.json');

    fs.mkdirSync(templatesDir, { recursive: true });

    // Create files with special characters
    fs.writeFileSync(path.join(templatesDir, 'email-template.pug'), 'p Email');
    fs.writeFileSync(path.join(templatesDir, 'user_profile.pug'), 'p Profile');

    // Run the script
    execSync(`npx ts-node ${scriptPath} ${templatesDir} ${outputFile}`, {
      stdio: 'pipe',
    });

    // Verify files are included with correct names
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(result['email-template.pug']).toBe('p Email');
    expect(result['user_profile.pug']).toBe('p Profile');
  });

  it('should create output file with proper JSON formatting', () => {
    const templatesDir = path.join(testTempDir, 'templates');
    const outputFile = path.join(testTempDir, 'output.json');

    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'test.pug'), 'p Test');

    // Run the script
    execSync(`npx ts-node ${scriptPath} ${templatesDir} ${outputFile}`, {
      stdio: 'pipe',
    });

    // Read raw file content
    const rawContent = fs.readFileSync(outputFile, 'utf-8');

    // Verify it's properly formatted JSON (with indentation)
    expect(rawContent).toContain('{\n');
    expect(rawContent).toContain('  "test.pug"');

    // Verify it's valid JSON
    expect(() => JSON.parse(rawContent)).not.toThrow();
  });
});
