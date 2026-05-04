<cfscript>
    // Phase 1: queries inside cfscript are not detected.
    var q = new Query();
    q.setSQL("SELECT * FROM users");
    var result = q.execute().getResult();
</cfscript>
