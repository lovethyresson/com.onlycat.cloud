import Homey from 'homey';

class OnlyCatApp extends Homey.App {

    /**
     * The gateway registry, keyed by API key. Deliberately hung off the App instance rather than
     * kept at module scope the way `com.nibe.local` keeps its connections: Athom's Homey Cloud
     * guidance is explicit that a cloud app is multi-tenant and must not use globals. Honouring
     * that costs nothing here and is what keeps `platforms: ["cloud"]` a one-line change later.
     */
    _onlycatGateways?: Map<string, unknown>;

    async onInit(): Promise<void> {
      // A rejected promise nobody awaited is otherwise invisible: Homey's app host does not
      // print one, so the only symptom is a device that quietly stopped updating.
      process.on('unhandledRejection', (reason: any) => {
        this.error('Unhandled promise rejection:', reason?.stack ?? reason?.message ?? reason);
      });

      this.log('OnlyCat app has been initialized');
    }

}

module.exports = OnlyCatApp;
