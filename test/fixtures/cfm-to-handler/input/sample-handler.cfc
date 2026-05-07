component {

    function index( event, rc, prc ) {
        var id = url.id;
        prc.deptId = url.deptId;
        prc.name = form.name;
        if (form.id EQ url.id) {
            prc.match = url["foo"];
        }
        prc.bar = form['bar baz'];
        // url.id in a comment should not be rewritten
        var note = "url.id in a string should not be rewritten";
        var nested = someObj.url.foo;
    }

    function noRcFunction( event ) {
        var x = url.id;
    }

}
