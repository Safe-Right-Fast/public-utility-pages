window.srfQbRest = {
    getTempToken: async (realm, dbid, apptoken) => {
        const res = await fetch(`https://api.quickbase.com/v1/auth/temporary/${dbid}`, {
            method: "GET",
            credentials: "include",
            headers: {
                "QB-Realm-Hostname": realm,
                "QB-App-Token": apptoken
            },
        });
        if (!res.ok) throw new Error('Auth failed');
        return await res.json();
    }
};
