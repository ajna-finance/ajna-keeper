import main from './deploy-factory-system-cli';

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}
